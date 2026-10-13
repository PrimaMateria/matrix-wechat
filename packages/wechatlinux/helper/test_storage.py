import base64
import hashlib
import json
import sqlite3
import unittest

from storage import Storage, StorageError, identifier


class FakeNative:
    """Real SQLite fixtures behind the exact native result contract."""
    def __init__(self):
        self.connections = {}
        self.visible = []
        self.force_truncated = False

    def add(self, path):
        connection = sqlite3.connect(":memory:")
        # Fixtures exercise projection contracts, not Tencent's decoder.
        connection.create_function("wcdb_decompress", 2, lambda value, marker: value)
        ident = str(len(self.connections) + 1)
        self.connections[ident] = connection
        self.visible.append({"id": ident, "path": path, "encrypted": True})
        return connection

    def databases(self):
        return self.visible

    def query(self, ident, sql, max_rows):
        cursor = self.connections[ident].execute(sql)
        rows = cursor.fetchmany(max_rows + 1)
        def native(value):
            if isinstance(value, int):
                return str(value)
            if isinstance(value, bytes):
                return {"base64": base64.b64encode(value).decode()}
            return value
        return {"columns": [item[0] for item in cursor.description], "rows": [[native(value) for value in row] for row in rows[:max_rows]],
                "truncated": self.force_truncated or len(rows) > max_rows}


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.native = FakeNative()
        self.db = self.native.add("/account/db_storage/message/message_0.db")
        self.db.execute("CREATE TABLE Name2Id(user_name TEXT)")
        self.db.executemany("INSERT INTO Name2Id VALUES(?)", [("wxid_friend",), ("wxid_self",), ("example@chatroom",)])
        self.table = "Msg_" + hashlib.md5(b"wxid_friend").hexdigest()
        self.db.execute("CREATE TABLE " + identifier(self.table) + "(local_id INTEGER PRIMARY KEY, server_id INTEGER, create_time INTEGER, real_sender_id INTEGER, local_type INTEGER, message_content, WCDB_CT_message_content INTEGER)")
        self.storage = Storage(self.native, "wxid_self")

    def insert(self, local, server=0, content="hello", kind=1, timestamp=100, marker=0, table=None, connection=None):
        (connection or self.db).execute("INSERT INTO " + identifier(table or self.table) + " VALUES(?,?,?,?,?,?,?)", (local, server, timestamp, 1, kind, content, marker))

    def test_inspection_contacts_groups_and_identifier_quoting(self):
        contacts = self.native.add("/account/db_storage/contact/contact.db")
        table = 'Contact"Quoted'
        contacts.execute("CREATE TABLE " + identifier(table) + "(username TEXT, nick_name TEXT, remark TEXT)")
        contacts.executemany("INSERT INTO " + identifier(table) + " VALUES(?,?,?)", [("wxid_friend", "Nickname", "Remark"), ("example@chatroom", "Group", "")])
        inspection = self.storage.inspect()
        self.assertEqual(len(inspection["databases"]), 2)
        self.assertTrue(inspection["databases"][0]["readable"])
        self.assertEqual(self.storage.contacts()["contacts"][0]["name"], "Remark")
        self.assertEqual(self.storage.groups()["groups"][0]["id"], "example@chatroom")

    def test_initial_baseline_insert_update_id_assignment_and_delete(self):
        self.assertEqual(self.storage.poll(), [])
        self.insert(1)
        added = self.storage.poll()
        self.assertEqual(added[0]["type"], "message")
        old_id = added[0]["message"]["id"]
        self.assertTrue(old_id.startswith("local:"))
        self.db.execute("UPDATE " + identifier(self.table) + " SET server_id=9007199254740999 WHERE local_id=1")
        updated = self.storage.poll()
        self.assertEqual(updated[0]["type"], "message.updated")
        self.assertEqual(updated[0]["message"]["id"], "9007199254740999")
        self.assertEqual(updated[0]["data"]["previous_id"], old_id)
        self.assertEqual(self.storage.poll(), [])
        self.db.execute("DELETE FROM " + identifier(self.table))
        deleted = self.storage.poll()
        self.assertEqual(deleted[0]["type"], "message.deleted")
        self.assertEqual(deleted[0]["data"]["reason"], "storage_disappearance")

    def test_history_cursor_media_and_compressed_text_remain_honest(self):
        self.insert(1, 101, content=b"compressed", timestamp=101, marker=4)
        self.insert(2, 102, content="second", timestamp=102)
        self.insert(3, 103, content='<msg><img path="/etc/passwd"/></msg>', kind=3, timestamp=103)
        first = self.storage.history({"chat_id": "wxid_friend", "limit": 2})
        self.assertEqual([row["id"] for row in first["messages"]], ["103", "102"])
        second = self.storage.history({"chat_id": "wxid_friend", "limit": 2, "cursor": first["next_cursor"]})
        compressed = second["messages"][0]
        self.assertNotIn("text", compressed)
        self.assertFalse(compressed["native"]["content_decoded"])
        self.assertEqual(compressed["native"]["row"]["message_content"], {"base64": base64.b64encode(b"compressed").decode()})
        media = self.storage.media({"message_id": "103"})
        self.assertEqual(media["state"], "pending")
        self.assertNotIn("path", media)
        for params in ({"chat_id": "wxid_friend", "cursor": "invalid"}, {"chat_id": "wxid_friend", "limit": 0}):
            with self.assertRaises(StorageError) as caught:
                self.storage.history(params)
            self.assertEqual(caught.exception.code, "invalid_params")

    def test_shards_use_independent_sender_map_and_deduplicate_server_ids(self):
        self.insert(1, 800, timestamp=100)
        second = self.native.add("/account/db_storage/message/message_1.db")
        second.execute("CREATE TABLE Name2Id(user_name TEXT)")
        second.executemany("INSERT INTO Name2Id VALUES(?)", [("wxid_self",), ("wxid_friend",)])
        second.execute("CREATE TABLE " + identifier(self.table) + "(local_id INTEGER PRIMARY KEY, server_id INTEGER, create_time INTEGER, real_sender_id INTEGER, local_type INTEGER, message_content, WCDB_CT_message_content INTEGER)")
        self.insert(5, 800, connection=second)
        rows = self.storage.history({"chat_id": "wxid_friend"})["messages"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["sender_id"], "wxid_self")
        self.assertTrue(rows[0]["own"])

    def test_missing_shard_and_truncation_do_not_emit_false_deletes(self):
        self.insert(1, 10)
        self.storage.poll()
        previous = self.storage._snapshot
        self.native.force_truncated = True
        with self.assertRaises(StorageError) as caught:
            self.storage.poll()
        self.assertEqual(caught.exception.code, "scan_limit")
        self.assertIs(self.storage._snapshot, previous)
        self.native.force_truncated = False
        second = self.native.add("/account/db_storage/message/message_1.db")
        second.execute("CREATE TABLE direct(username TEXT, local_id INTEGER, create_time INTEGER, real_sender_id TEXT, local_type INTEGER, message_content TEXT)")
        self.storage.poll()
        self.native.visible.pop()
        with self.assertRaises(StorageError) as caught:
            self.storage.poll()
        self.assertEqual(caught.exception.code, "unverified")

    def test_unknown_schemas_and_unmapped_chats_are_explicit_errors(self):
        with self.assertRaises(StorageError):
            self.storage.contacts()
        self.db.execute("ALTER TABLE " + identifier(self.table) + " RENAME TO UnmappedMessages")
        with self.assertRaises(StorageError) as caught:
            self.storage.history({"chat_id": "wxid_friend"})
        self.assertEqual(caught.exception.code, "unsupported_schema")
        self.native.visible.clear()
        with self.assertRaises(StorageError) as caught:
            self.storage.inspect()
        self.assertEqual(caught.exception.code, "unverified")

    def test_reply_file_and_location_require_plaintext_xml(self):
        self.insert(1, 11, kind=49, content="<msg><appmsg><type>57</type><title>reply text</title><refermsg><svrid>9007199254740999</svrid></refermsg></appmsg></msg>")
        self.insert(2, 12, kind=49, content="<msg><appmsg><type>6</type></appmsg></msg>")
        self.insert(3, 13, kind=48, content='<msg><location x="40" y="-73" label="Place"/></msg>')
        self.insert(4, 14, kind=49, content="<!DOCTYPE x [<!ENTITY boom 'bad'>]><msg>&boom;</msg>")
        rows = {row["id"]: row for row in self.storage.history({"chat_id": "wxid_friend"})["messages"]}
        self.assertEqual(rows["11"]["reply_to"], "9007199254740999")
        self.assertEqual(rows["11"]["text"], "reply text")
        self.assertEqual(rows["12"]["kind"], "file")
        self.assertEqual(rows["13"]["location"]["longitude"], -73)
        self.assertEqual(rows["14"]["kind"], "unknown")

    def test_account_change_and_reset_start_new_baselines(self):
        self.insert(1, 10)
        self.storage.poll()
        self.storage.account_id = "different_account"
        self.db.execute("DELETE FROM " + identifier(self.table))
        self.assertEqual(self.storage.poll(), [])
        self.storage.reset()
        self.insert(2, 20)
        self.assertEqual(self.storage.poll(), [])

    def test_verified_native_decoder_pair_preserves_original_blob(self):
        self.db.execute("ALTER TABLE " + identifier(self.table) + " ADD COLUMN source TEXT")
        self.db.execute("ALTER TABLE " + identifier(self.table) + " ADD COLUMN WCDB_CT_source INTEGER")
        payload = b"fixture_encoded"
        self.db.create_function("wcdb_decompress", 2, lambda value, marker: "decoded text" if value == payload and marker == 4 else value)
        self.db.execute("INSERT INTO " + identifier(self.table) + " VALUES(1,123,100,1,1,?,4,?,0)", (payload, "<msgsource><atuserlist>wxid_self,wxid_other</atuserlist></msgsource>"))
        message = self.storage.history({"chat_id": "wxid_friend"})["messages"][0]
        self.assertEqual(message["text"], "decoded text")
        self.assertEqual(message["mentions"], ["wxid_self", "wxid_other"])
        self.assertTrue(message["native"]["content_decoded"])
        self.assertEqual(message["native"]["row"]["message_content"], {"base64": base64.b64encode(payload).decode()})
        self.assertNotIn("__helper_decoded_content", message["native"]["row"])

    def test_actual_contact_roster_session_and_revoke_schemas(self):
        contact = self.native.add("/account/db_storage/contact/contact.db")
        contact.execute("CREATE TABLE contact(id INTEGER,username TEXT,local_type INTEGER,alias TEXT,flag INTEGER,delete_flag INTEGER,verify_flag INTEGER,remark TEXT,nick_name TEXT,big_head_url TEXT,small_head_url TEXT,chat_room_notify INTEGER,is_in_chat_room INTEGER)")
        contact.executemany("INSERT INTO contact VALUES(?,?,0,'',0,0,0,'',?,?,NULL,0,1)", [(1, "wxid_friend", "Friend", "https://example.invalid/avatar"), (2, "example@chatroom", "Group", "https://example.invalid/group")])
        contact.execute("CREATE TABLE chat_room(id INTEGER,username TEXT,owner TEXT,ext_buffer BLOB)")
        contact.execute("INSERT INTO chat_room VALUES(10,'example@chatroom','wxid_friend',X'01')")
        contact.execute("CREATE TABLE chat_room_info_detail(room_id_ INTEGER,username_ TEXT,announcement_ TEXT,announcement_editor_ TEXT,announcement_publish_time_ INTEGER,chat_room_status_ INTEGER,xml_announcement_ TEXT,ext_buffer_ BLOB)")
        contact.execute("INSERT INTO chat_room_info_detail VALUES(10,'example@chatroom','Announcement','wxid_friend',100,0,'',X'02')")
        contact.execute("CREATE TABLE chatroom_member(room_id INTEGER,member_id INTEGER)")
        contact.execute("INSERT INTO chatroom_member VALUES(10,1)")
        group = self.storage.groups()["groups"][0]
        self.assertEqual(group["topic"], "Announcement")
        self.assertEqual(group["avatar"], "https://example.invalid/group")
        self.assertEqual(group["members"][0]["id"], "wxid_friend")
        self.assertEqual(group["native"]["native_room"]["ext_buffer"], {"base64": "AQ=="})
        session = self.native.add("/account/db_storage/session/session.db")
        session.execute("CREATE TABLE SessionTable(username TEXT,type INTEGER,unread_count INTEGER,last_timestamp INTEGER)")
        session.execute("INSERT INTO SessionTable VALUES('example@chatroom',2,3,123)")
        conversation = self.storage.conversations()["conversations"][0]
        self.assertEqual(conversation["unread_count"], 3)
        self.assertEqual(conversation["chat_type"], "group")
        general = self.native.add("/account/db_storage/general/general.db")
        general.execute("CREATE TABLE revokemessage(to_user_name TEXT,svr_id INTEGER,message_type INTEGER,revoke_time INTEGER,content TEXT,at_user_list TEXT)")
        self.storage.poll()
        general.execute("INSERT INTO revokemessage VALUES('wxid_friend',9007199254740999,1,200,'revoked','')")
        events = self.storage.poll()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "message.revoked")
        self.assertEqual(events[0]["message"]["revoke_target"], "9007199254740999")
        self.assertEqual(self.storage.poll(), [])


if __name__ == "__main__":
    unittest.main()
