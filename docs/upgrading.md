# Upgrade to bridgev2

This is a fresh-state upgrade. Old Matrix rooms remain in the homeserver; the new bridge does not import their mappings. The WeChat hook is pending, so keep the old deployment if real WeChat traffic is required until its adapter is available.

1. Stop the old bridge and record its exact binary/image version.
2. Back up config, registration, bridge database, crypto data, and agent state. For SQLite, stop writers and include remaining WAL/SHM files.
3. Use a separate data directory and fresh database. The example filename is `matrix-wechat-v2.db`.
4. Copy `example-config.yaml`, configure homeserver/permissions, and generate registration with `matrix-wechat -g`.
5. Replace the old homeserver registration and restart the homeserver. Avoid overlapping appservice namespaces.
6. Start the new bridge. Its backend remains disabled until the adapter is installed. Fixtures require explicit `network.backend: fake`.

Legacy config is detected before config upgrading; legacy database tables are detected before schema upgrading. Both fail with upgrade instructions. Keep registration/config together: registration generation updates the config tokens.

The framework owns the database, encryption, double puppeting, logins, spaces, and message checkpoints. Old `bridge.listen_address`, `bridge.listen_secret`, shared-secret login maps, and the agent WebSocket protocol are replaced by the backend contract and bridgev2 configuration. Outbound features depend on hook capabilities.

## Rollback

Stop the new bridge. Restore the old image/binary and untouched data directory, replace the homeserver registration with the saved original, and restart the homeserver. Do not open the new database with the old binary. New portal rooms can be retained or manually removed; restored old state preserves the old room mappings.
