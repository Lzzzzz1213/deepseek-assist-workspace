"""模拟两种启动环境的专用数据目录，仅使用临时目录。"""
import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import workroom_server
from workroom_storage import resolve_event_directory


class StoragePathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='workroom-storage-')
        self.root = Path(self.temp.name)
        self.standard = self.root/'CodexDeepSeekHelper/workroom/events'

    def tearDown(self):
        self.temp.cleanup()

    def cache(self, family='OpenAI.Codex_test'):
        package = self.root/'Packages'/family
        package.mkdir(parents=True, exist_ok=True)
        return package/'LocalCache/Local/CodexDeepSeekHelper/workroom/events'

    def record(self, directory):
        directory.mkdir(parents=True, exist_ok=True)
        (directory/('a'*32+'.jsonl')).write_text('{}\n', encoding='utf-8')

    def test_normal_launch_finds_actual_codex_cache(self):
        cached = self.cache()
        self.record(cached)
        self.assertFalse(self.standard.exists())
        self.assertEqual(resolve_event_directory(self.root), cached)

    def test_virtual_alias_and_normal_launch_resolve_same_store(self):
        cached = self.cache()
        self.record(cached)
        self.record(self.standard)
        self.assertEqual(resolve_event_directory(self.root), cached)
        (self.standard/('a'*32+'.jsonl')).unlink()
        self.standard.rmdir()
        self.assertEqual(resolve_event_directory(self.root), cached)

    def test_conventional_store_without_codex_cache_is_preserved(self):
        self.record(self.standard)
        self.assertEqual(resolve_event_directory(self.root), self.standard)

    def test_real_records_win_over_empty_package_cache(self):
        self.cache()
        self.record(self.standard)
        self.assertEqual(resolve_event_directory(self.root), self.standard)

    def test_future_first_record_uses_package_target_without_creating_it(self):
        cached = self.cache()
        self.assertEqual(resolve_event_directory(self.root), cached)
        self.assertFalse(cached.exists())
        self.record(cached)
        self.assertEqual(resolve_event_directory(self.root), cached)

    def test_unrelated_packages_are_not_used(self):
        self.record(self.cache('OtherApp_test'))
        self.assertEqual(resolve_event_directory(self.root), self.standard)

    def test_invalid_record_names_do_not_override_conventional_data(self):
        cached = self.cache()
        cached.mkdir(parents=True)
        (cached/'notes.txt').write_text('not a record', encoding='utf-8')
        (cached/'wrong.jsonl').write_text('{}\n', encoding='utf-8')
        self.record(self.standard)
        self.assertEqual(resolve_event_directory(self.root), self.standard)

    def test_explicit_data_dir_never_uses_automatic_discovery(self):
        specified = str(self.root/'isolated')
        with patch.object(sys,'argv',['workroom_server.py','--port','0','--data-dir',specified]), \
             patch.object(workroom_server,'resolve_event_directory',side_effect=AssertionError('Must not discover')), \
             patch.object(workroom_server,'WorkroomServer') as factory, contextlib.redirect_stdout(io.StringIO()):
            factory.return_value.server_address = ('127.0.0.1', 12345)
            workroom_server.main()
            factory.assert_called_once_with(0, specified, view_state_dir=None)


if __name__ == '__main__':
    unittest.main()
