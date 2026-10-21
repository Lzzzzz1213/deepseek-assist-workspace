"""工作区归并的边界验证：只使用临时事件文件。"""
import copy
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

import client_history
from client_history import HistoryError
from workspace_groups import group_workspace_events
from workroom_server import EventStore, WorkroomServer


class WorkspaceGroupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='workroom-workspace-')
        root = Path(self.temp.name)
        self.path = root / 'events'
        self.path.mkdir()
        self.view_state_dir = root / 'client-state'

    def tearDown(self):
        self.temp.cleanup()

    def make_store(self):
        return EventStore(self.path, view_state_dir=self.view_state_dir)

    def make_server(self):
        return WorkroomServer(0, self.path, Path(__file__).parent, view_state_dir=self.view_state_dir)

    def write_run(self, number, directory, source='chat-a', completed=True):
        run = format(number, '032x')
        room = format(number + 1000, '032x')
        common = {'v': 1, 'runId': run, 'roomId': room, 'actor': 'codex'}
        records = [
            dict(common, eventId=run+'c', time='2026-10-17T00:00:00Z', type='task.created', text='明确任务 '+str(number),
                 payload={'title':'任务 '+str(number), 'roomTitle':'本轮名称 '+str(number), 'sourceThreadId':source,
                          'workingDirectory':directory, 'parentPid':os.getpid()}),
            dict(common, eventId=run+'m', time='2026-10-17T00:01:00Z', type='message', text='公开回复 '+str(number), payload={'phase':'public'}),
        ]
        if completed:
            records.append(dict(common, eventId=run+'e', time='2026-10-17T00:02:00Z', type='task.completed', text='', payload={'status':'success'}))
        file = self.path / (run+'.jsonl')
        file.write_text(''.join(json.dumps(x)+'\n' for x in records), encoding='utf-8')
        return run, file, records

    @staticmethod
    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def test_tasks_and_chats_share_workspace_with_immutable_cache(self):
        first, file, _ = self.write_run(1, r'C:\projects\Alpha')
        self.write_run(2, 'c:/PROJECTS/alpha/', 'chat-b')
        before = self.digest(file)
        store = self.make_store()
        state = store.state()
        self.assertEqual(len(state['rooms']), 1)
        room = state['rooms'][0]
        self.assertRegex(room['id'], r'^[0-9a-f]{32}$')
        self.assertEqual((room['runCount'], room['messageCount'], room['grouping']), (2, 4, 'workspace'))
        self.assertEqual(room['sourceThreadIds'], ['chat-a', 'chat-b'])
        self.assertEqual(room['sourceThreadId'], '')
        self.assertEqual(len(store.detail(room['id'])['runs']), 2)
        self.assertEqual(len(store.detail(room['id'])['messages']), 4)
        self.assertEqual(store.cache[first][1][0]['roomId'], format(1001,'032x'))
        self.assertEqual(self.digest(file), before)
        self.assertEqual(store.state()['revision'], state['revision'])

    def test_staging_subdirectories_join_project_but_distinct_workspaces_do_not(self):
        for number, directory in enumerate([r'C:\projects\Alpha', r'C:\projects\Alpha\work\review\part',
                                            r'D:\other\Alpha', r'C:\projects\Alpha\workforce', r'C:\work\Alpha'], 1):
            self.write_run(number, directory)
        rooms = self.make_store().state()['rooms']
        self.assertEqual(len(rooms), 4)
        self.assertEqual(sorted(x['runCount'] for x in rooms), [1,1,1,2])

    def test_missing_invalid_directories_keep_original_groups(self):
        invalid = ['', 'relative/path', r'\rooted\path', r'\\?\C:\projects\Alpha', 'C:\\\\bad\x00name']
        for number, directory in enumerate(invalid, 1):
            self.write_run(number, directory)
        rooms = self.make_store().state()['rooms']
        self.assertEqual(len(rooms), len(invalid))
        self.assertTrue(all(x['grouping'] != 'workspace' for x in rooms))

    def test_later_task_keeps_group_identity(self):
        self.write_run(1, r'C:\projects\Alpha')
        store = self.make_store()
        room_id = store.state()['rooms'][0]['id']
        self.write_run(2, r'C:\projects\Alpha\work\next', 'different-chat')
        room = store.state()['rooms'][0]
        self.assertEqual(room['id'], room_id)
        self.assertEqual(room['runCount'], 2)

    def test_group_delete_hides_only_that_workspace_and_preserves_sources(self):
        first, one, _ = self.write_run(1, r'C:\projects\Alpha')
        second, two, _ = self.write_run(2, r'C:\projects\Alpha\work\review')
        third, other, _ = self.write_run(3, r'D:\other\Beta')
        before = {path: self.digest(path) for path in (one, two, other)}
        store = self.make_store()
        state = store.state()
        room = next(x for x in state['rooms'] if x['runCount'] == 2)
        other_room = next(x for x in state['rooms'] if x['runCount'] == 1)
        status, result = store.delete(room['id'], room['clearRevision'])
        self.assertEqual(status, 200)
        self.assertEqual(result, {'deleted': 2, 'scope': 'client-only', 'sourcePreserved': True})
        for path, digest in before.items():
            self.assertTrue(path.exists())
            self.assertEqual(self.digest(path), digest)
        visible = store.state()
        self.assertEqual([x['id'] for x in visible['rooms']], [other_room['id']])
        self.assertEqual(visible['stats'], {'rooms': 1, 'runs': 1, 'running': 0, 'messages': 2})
        self.assertIsNone(store.detail(room['id']))
        detail = store.detail(other_room['id'])
        self.assertEqual({x['id'] for x in detail['runs']}, {third})
        self.assertNotIn(first, {x['runId'] for x in detail['messages']})
        self.assertNotIn(second, {x['runId'] for x in detail['messages']})

    def test_delete_revision_and_running_boundaries(self):
        first, one, _ = self.write_run(1, r'C:\projects\Alpha')
        second, two, _ = self.write_run(2, r'C:\projects\Alpha\work\review')
        running, active, _ = self.write_run(3, r'D:\other\Beta', completed=False)
        before = {path: self.digest(path) for path in (one, two, active)}
        store = self.make_store()
        state = store.state()
        room = next(x for x in state['rooms'] if x['runCount'] == 2)
        active_room = next(x for x in state['rooms'] if x['id'] != room['id'])
        self.assertEqual(store.delete(room['id'])[0], 400)
        revision = room['clearRevision']
        self.assertRegex(revision, r'^[0-9a-f]{20}$')
        store.history.hide([first])
        refreshed = store.detail(room['id'])
        self.assertNotEqual(refreshed['room']['clearRevision'], revision)
        self.assertEqual(store.delete(room['id'], revision)[0], 409)
        self.assertEqual(store.history.load(), {first})
        self.assertEqual(store.delete(active_room['id'], active_room['clearRevision'])[0], 409)
        self.assertEqual(store.history.load(), {first})
        self.assertNotIn(running, store.history.load())
        for path, digest in before.items():
            self.assertTrue(path.exists())
            self.assertEqual(self.digest(path), digest)

    def test_running_task_protects_whole_workspace(self):
        self.write_run(1, r'C:\projects\Alpha')
        self.write_run(2, r'C:\projects\Alpha\work\active', completed=False)
        store = self.make_store()
        room = store.state()['rooms'][0]
        self.assertEqual((room['status'], room['runCount']), ('running', 2))
        self.assertEqual(store.delete(room['id'])[0], 409)
        self.assertEqual(len(list(self.path.glob('*.jsonl'))), 2)

    def test_hidden_group_persists_and_new_run_reappears_without_old_runs(self):
        old_one, one, _ = self.write_run(1, r'C:\projects\Alpha')
        old_two, two, _ = self.write_run(2, r'C:\projects\Alpha\work\next', 'chat-b')
        before = {path: self.digest(path) for path in (one, two)}
        store = self.make_store()
        room = store.state()['rooms'][0]
        self.assertEqual(store.delete(room['id'], room['clearRevision'])[0], 200)
        self.assertEqual(store.state()['rooms'], [])

        restarted = self.make_store()
        self.assertEqual(restarted.state()['rooms'], [])
        self.assertIsNone(restarted.detail(room['id']))

        new_run, new_file, _ = self.write_run(3, r'C:\projects\Alpha\work\later', 'chat-c')
        state = restarted.state()
        self.assertEqual(len(state['rooms']), 1)
        self.assertEqual(state['rooms'][0]['runCount'], 1)
        self.assertEqual(state['stats'], {'rooms': 1, 'runs': 1, 'running': 0, 'messages': 2})
        export = restarted.detail(state['rooms'][0]['id'])
        self.assertEqual({x['id'] for x in export['runs']}, {new_run})
        self.assertEqual({x['runId'] for x in export['messages']}, {new_run})
        self.assertFalse({old_one, old_two} & {x['id'] for x in export['runs']})
        self.assertFalse({old_one, old_two} & {x['runId'] for x in export['messages']})
        for path, digest in before.items():
            self.assertTrue(path.exists())
            self.assertEqual(self.digest(path), digest)
        self.assertTrue(new_file.exists())
        self.assertEqual(restarted.delete(state['rooms'][0]['id'], export['room']['clearRevision'])[0], 200)

    def test_marker_save_failure_does_not_partially_hide_or_touch_sources(self):
        first, one, _ = self.write_run(1, r'C:\projects\Alpha')
        second, two, _ = self.write_run(2, r'C:\projects\Alpha\work\review')
        before = {path: self.digest(path) for path in (one, two)}
        store = self.make_store()
        room = store.state()['rooms'][0]
        with mock.patch.object(client_history.os, 'replace', side_effect=OSError('injected save failure')):
            status, result = store.delete(room['id'], room['clearRevision'])
        self.assertEqual(status, 409)
        self.assertIn('无法保存客户端删除标记', result['error'])
        self.assertEqual(store.history.load(), set())
        self.assertFalse(store.history.path.exists())
        visible = store.state()
        self.assertEqual(visible['stats'], {'rooms': 1, 'runs': 2, 'running': 0, 'messages': 4})
        for path, digest in before.items():
            self.assertTrue(path.exists())
            self.assertEqual(self.digest(path), digest)

    def test_corrupt_marker_is_reported_and_not_reset(self):
        self.write_run(1, r'C:\projects\Alpha')
        store = self.make_store()
        room = store.state()['rooms'][0]
        store.history.path.parent.mkdir(parents=True, exist_ok=True)
        store.history.path.write_bytes(b'{"v":1,"hiddenRuns":')
        before = store.history.path.read_bytes()
        state = store.state()
        self.assertEqual(state['privacy']['readStatus']['state'], 'error')
        self.assertTrue(state['privacy']['readStatus']['errors'])
        status, result = store.delete(room['id'], room['clearRevision'])
        self.assertEqual(status, 409)
        self.assertTrue(result['error'])
        self.assertEqual(store.history.path.read_bytes(), before)
        restarted = self.make_store()
        self.assertEqual(restarted.state()['privacy']['readStatus']['state'], 'error')
        self.assertEqual(store.history.path.read_bytes(), before)

    def test_marker_directory_is_isolated_from_event_tree(self):
        store = self.make_store()
        self.assertTrue(store.history.directory.is_relative_to(self.view_state_dir))
        self.assertFalse(store.history.path.is_relative_to(self.path))
        with self.assertRaises(HistoryError):
            EventStore(self.path, view_state_dir=self.path)
        with self.assertRaises(HistoryError):
            EventStore(self.path, view_state_dir=Path(self.temp.name) / '.codex')
        with self.assertRaises(HistoryError):
            EventStore(self.path, view_state_dir=Path(self.temp.name) / 'OpenAI.Codex_test')

    def test_marker_hard_link_is_rejected(self):
        run, _, _ = self.write_run(1, r'C:\projects\Alpha')
        store = self.make_store()
        store.history.hide([run])
        linked = Path(self.temp.name) / 'linked-marker.json'
        try:
            os.link(store.history.path, linked)
        except (OSError, NotImplementedError):
            self.skipTest('文件系统不支持硬链接')
        with self.assertRaises(HistoryError):
            store.history.load()

    def test_parent_segments_cannot_put_markers_in_event_tree(self):
        alias = Path(self.temp.name) / 'safe' / '..' / 'events'
        with self.assertRaises(HistoryError):
            EventStore(self.path, view_state_dir=alias)
        self.assertFalse((self.path / 'client-history').exists())

    @unittest.skipUnless(os.name == 'nt', '仅验证 Win32 文件别名')
    def test_windows_aliases_cannot_bypass_marker_boundary(self):
        for component in ('.codex.', 'client-state ', 'CON', 'state:stream'):
            with self.subTest(component=component), self.assertRaises(HistoryError):
                EventStore(self.path, view_state_dir=Path(self.temp.name) / component)

    def test_parallel_clients_keep_both_groups_hidden(self):
        first, first_file, _ = self.write_run(1, r'C:\projects\Alpha')
        second, second_file, _ = self.write_run(2, r'D:\other\Beta')
        before = {path: self.digest(path) for path in (first_file, second_file)}
        clients = [self.make_store(), self.make_store()]
        rooms = clients[0].state()['rooms']
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda pair: pair[0].delete(pair[1]['id'], pair[1]['clearRevision']),
                                    zip(clients, rooms)))
        self.assertEqual([result[0] for result in results], [200, 200])
        self.assertEqual(self.make_store().history.load(), {first, second})
        self.assertEqual(self.make_store().state()['rooms'], [])
        for path, digest in before.items():
            self.assertEqual(self.digest(path), digest)

    def test_hidden_files_do_not_fill_visible_file_limit(self):
        for number in range(1, 1002):
            self.write_run(number, r'C:\projects\Alpha')
        store = self.make_store()
        store.history.hide(format(number, '032x') for number in range(1, 1001))
        state = store.state()
        self.assertEqual(state['stats']['runs'], 1)
        detail = store.detail(state['rooms'][0]['id'])
        self.assertEqual([run['id'] for run in detail['runs']], [format(1001, '032x')])
        self.assertEqual(len(list(self.path.glob('*.jsonl'))), 1001)

    def test_marker_directory_symlink_is_rejected(self):
        target = Path(self.temp.name) / 'real-client-state'
        target.mkdir()
        linked = Path(self.temp.name) / 'linked-client-state'
        try:
            linked.symlink_to(target, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest('当前环境不允许创建目录符号链接')
        store = EventStore(self.path, view_state_dir=linked)
        with self.assertRaises(HistoryError):
            store.history.load()

    def test_two_instances_merge_marker_updates_without_loss(self):
        first, _, _ = self.write_run(1, r'C:\projects\Alpha')
        second, _, _ = self.write_run(2, r'C:\projects\Alpha\work\review')
        one = self.make_store()
        two = self.make_store()
        one.history.hide([first])
        two.history.hide([second])
        self.assertEqual(one.history.load(), {first, second})
        self.assertEqual(two.history.load(), {first, second})
        self.assertEqual(one.state()['rooms'], [])
        self.assertEqual(two.state()['rooms'], [])

    def test_conflicting_run_directory_is_not_assigned_to_workspace(self):
        _, _, records = self.write_run(1, r'C:\projects\Alpha')
        second = copy.deepcopy(records[0])
        second['payload']['workingDirectory'] = r'D:\projects\Beta'
        records.append(second)
        before = copy.deepcopy(records)
        grouped = group_workspace_events(records)
        self.assertEqual(records, before)
        self.assertEqual({x['roomId'] for x in grouped}, {records[0]['roomId']})

    def test_unc_paths_normalize_case_and_separators(self):
        self.write_run(1, r'\\Server\Share\Project')
        self.write_run(2, '//server/share/PROJECT/work/review')
        self.assertEqual(len(self.make_store().state()['rooms']), 1)

    def test_grouped_workspace_http_export_uses_valid_room_id(self):
        self.write_run(1, r'C:\projects\Alpha')
        self.write_run(2, r'C:\projects\Alpha\work\next', 'chat-b')
        server = self.make_server()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = http.client.HTTPConnection('127.0.0.1', server.server_address[1], timeout=3)
        try:
            client.request('GET', '/')
            response = client.getresponse()
            cookie = response.getheader('Set-Cookie').split(';')[0]
            response.read()
            auth = {'Cookie':cookie, 'X-Workroom-Client':'1'}
            client.request('GET', '/api/state', headers=auth)
            response = client.getresponse()
            state = json.loads(response.read())
            room_id = state['rooms'][0]['id']
            client.request('GET', '/api/rooms/'+room_id+'/export', headers=auth)
            response = client.getresponse()
            self.assertEqual(response.status, 200)
            detail = json.loads(response.read())
            self.assertEqual(len(detail['runs']), 2)
            self.assertEqual(len(detail['messages']), 4)
        finally:
            client.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)

    def test_http_delete_requires_revision_and_preserves_source_files(self):
        first, one, _ = self.write_run(1, r'C:\projects\Alpha')
        second, two, _ = self.write_run(2, r'C:\projects\Alpha\work\review')
        before = {path: self.digest(path) for path in (one, two)}
        server = self.make_server()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = http.client.HTTPConnection('127.0.0.1', server.server_address[1], timeout=3)
        try:
            client.request('DELETE', '/api/rooms/'+'0'*32, body='{}',
                           headers={'Content-Type':'application/json'})
            response = client.getresponse()
            self.assertEqual(response.status, 403)
            response.read()

            client.request('GET', '/')
            response = client.getresponse()
            cookie = response.getheader('Set-Cookie').split(';')[0]
            response.read()
            auth = {'Cookie':cookie, 'X-Workroom-Client':'1'}
            client.request('GET', '/api/state', headers=auth)
            response = client.getresponse()
            state = json.loads(response.read())
            room_id = state['rooms'][0]['id']

            client.request('DELETE', '/api/rooms/'+room_id, body='{}',
                           headers={**auth, 'Content-Type':'text/plain'})
            response = client.getresponse()
            self.assertEqual(response.status, 415)
            response.read()

            client.request('DELETE', '/api/rooms/'+room_id, body='{}',
                           headers={**auth, 'Content-Type':'application/json'})
            response = client.getresponse()
            self.assertEqual(response.status, 400)
            response.read()

            client.request('GET', '/api/rooms/'+room_id, headers=auth)
            response = client.getresponse()
            detail = json.loads(response.read())
            revision = detail['room']['clearRevision']
            self.assertRegex(revision, r'^[0-9a-f]{20}$')

            client.request('DELETE', '/api/rooms/'+room_id, body=json.dumps({'revision':revision}),
                           headers={**auth, 'Content-Type':'application/json'})
            response = client.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read()),
                             {'deleted': 2, 'scope': 'client-only', 'sourcePreserved': True})

            client.request('GET', '/api/state', headers=auth)
            response = client.getresponse()
            self.assertEqual(json.loads(response.read())['rooms'], [])
            client.request('GET', '/api/rooms/'+room_id+'/export', headers=auth)
            response = client.getresponse()
            self.assertEqual(response.status, 404)
            response.read()
        finally:
            client.close()
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)
        for path, digest in before.items():
            self.assertTrue(path.exists())
            self.assertEqual(self.digest(path), digest)


if __name__ == '__main__':
    unittest.main()
