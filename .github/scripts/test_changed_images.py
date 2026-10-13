import unittest
from changed_images import changed_images, changed_paths
from unittest.mock import patch


def packages(paths, force=False):
    return {row["package"] for row in changed_images(paths, force)["include"]}


class ChangedImagesTest(unittest.TestCase):
    def test_component_changes_build_only_that_image(self):
        self.assertEqual(packages(["packages/matrix-bridge/src/bridge.ts"]), {"matrix-bridge"})
        self.assertEqual(packages(["packages/wechat-runtime/src/server.ts"]), {"wechat-runtime"})
        self.assertEqual(packages(["example-config.yaml"]), {"matrix-bridge"})

    def test_shared_inputs_rebuild_both_images(self):
        for path in ["bun.lock", "package.json", ".dockerignore", ".gitignore",
                     "packages/wechat-rpc/src/router.ts", "packages/wechat-rpc/package.json",
                     "packages/matrix-bridge/package.json", "packages/wechat-runtime/package.json",
                     ".github/workflows/ci.yml", ".github/scripts/changed_images.py"]:
            with self.subTest(path=path):
                self.assertEqual(packages([path]), {"matrix-bridge", "wechat-runtime"})

    def test_documentation_and_deployment_only_changes_skip_images(self):
        self.assertEqual(packages(["README.md", "packages/wechat-runtime/README.md", "compose.yaml"]), set())

    def test_manual_runs_and_releases_always_build_both(self):
        self.assertEqual(packages([], force=True), {"matrix-bridge", "wechat-runtime"})

    def test_cross_component_moves_include_both_paths(self):
        self.assertEqual(packages(["packages/matrix-bridge/src/old.ts", "packages/wechat-runtime/src/new.ts"]),
                         {"matrix-bridge", "wechat-runtime"})

    @patch("changed_images.subprocess.check_output", return_value=b"packages/matrix-bridge/src/bridge.ts\0")
    def test_push_compares_the_entire_push_and_disables_rename_collapsing(self, check):
        self.assertEqual(changed_paths("push", {"before": "base", "after": "head"})[0],
                         "packages/matrix-bridge/src/bridge.ts")
        self.assertEqual(check.call_args.args[0],
                         ["git", "diff", "--name-only", "--no-renames", "-z", "base", "head", "--"])


if __name__ == "__main__":
    unittest.main()
