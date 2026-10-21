"""客户端主动私聊调度：仅使用私聊数据库与只读工作快照，不接入工作 Agent。"""
from datetime import datetime
import secrets
import threading
import time


class ProactiveChat:
    INTERVAL = 30

    def __init__(self, chat):
        self.chat = chat
        self.memory = chat.memory
        self.stopped = threading.Event()
        self.thread = None
        self.start_lock = threading.Lock()
        with self.memory.db() as db:
            self.initialize(db)

    @classmethod
    def initialize(cls, db):
        db.executescript('''
                CREATE TABLE IF NOT EXISTS proactive_settings(
                    id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL,
                    last_user REAL NOT NULL, last_activity REAL NOT NULL,
                    next_at REAL NOT NULL, last_proactive REAL NOT NULL,
                    read_through INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS proactive_requests(
                    request_id TEXT PRIMARY KEY, day TEXT NOT NULL, generation INTEGER NOT NULL);
            ''')
        db.execute("INSERT OR IGNORE INTO meta VALUES('desktop_notification',0)")
        # 升级时旧对话默认已读；初始化不能把旧消息重新通知一遍。
        latest = db.execute('SELECT COALESCE(MAX(id),0) FROM messages').fetchone()[0]
        user = db.execute("SELECT 1 FROM messages WHERE role='user' UNION ALL "
                          "SELECT 1 FROM memories WHERE source='chat' LIMIT 1").fetchone()
        stamp = time.time()
        db.execute('INSERT OR IGNORE INTO proactive_settings VALUES(1,1,?,?,?,?,?)',
                   (stamp if user else 0, stamp, stamp + cls.delay(), 0, latest))

    @staticmethod
    def delay():
        return 3600 + secrets.randbelow(3601)

    @staticmethod
    def daytime(stamp):
        # 用户选择全天允许；实际系统通知仍遵循Windows勿扰，不更改系统设置。
        return True

    @staticmethod
    def cancel(db, include_delivering=True):
        """只作废本客户端的自动问候，不停止网络线程，更不触碰工作进程。"""
        statuses = "'queued','running','delivering'" if include_delivering else "'queued','running'"
        result = db.execute("UPDATE requests SET status='cancelled' WHERE status IN (" + statuses + ') '
                            'AND id IN (SELECT request_id FROM proactive_requests)')
        if result.rowcount:
            db.execute("UPDATE meta SET value=value+1 WHERE key='revision'")

    @classmethod
    def user_activity(cls, db, *, user=False):
        # 打开/阅读已经开始的搭话时，让其余短句说完；实际发送新消息才打断尾段。
        cls.cancel(db, include_delivering=user)
        stamp = time.time()
        fields = 'last_activity=?,next_at=?' + (',last_user=?' if user else '')
        values = [stamp, stamp + cls.delay()] + ([stamp] if user else [])
        db.execute('UPDATE proactive_settings SET ' + fields + ' WHERE id=1', values)

    def inbox(self):
        with self.memory.db() as db:
            state = dict(db.execute('SELECT * FROM proactive_settings WHERE id=1').fetchone())
            unread = db.execute("SELECT COUNT(*) FROM messages WHERE role='assistant' AND id>?",
                                (state['read_through'],)).fetchone()[0]
            latest = db.execute("SELECT m.id,m.text,m.time,CASE WHEN p.request_id IS NULL THEN 'user' ELSE 'proactive' END kind "
                                "FROM messages m LEFT JOIN proactive_requests p ON p.request_id=m.request_id "
                                "WHERE role='assistant' ORDER BY m.id DESC LIMIT 1").fetchone()
        return {'enabled': bool(state['enabled']), 'unread': unread, 'readThrough': state['read_through'],
                'nextAt': state['next_at'], 'latest': dict(latest) if latest else None}

    def claim_notification(self, message_id):
        """只认领尚未读的主动消息；磁盘游标使系统通知跨窗口/重启最多认领一次。"""
        with self.memory.db() as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                row = db.execute("SELECT 1 FROM messages m JOIN proactive_requests p ON p.request_id=m.request_id "
                                 "JOIN proactive_settings s ON s.id=1 WHERE m.id=? AND m.role='assistant' "
                                 "AND s.enabled=1 AND m.id>s.read_through "
                                 "AND m.request_id NOT IN (SELECT batch_id FROM notified_batches) "
                                 "AND m.id>(SELECT value FROM meta WHERE key='desktop_notification')", (message_id,)).fetchone()
                if row:
                    db.execute('INSERT INTO notified_batches SELECT request_id FROM messages WHERE id=?', (message_id,))
                    db.execute("UPDATE meta SET value=? WHERE key='desktop_notification'", (message_id,))
                db.execute('COMMIT')
                return {'claimed': bool(row)}
            except Exception:
                db.execute('ROLLBACK')
                raise

    def activity(self, active=False, read_through=None):
        with self.memory.db() as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                if active:
                    self.user_activity(db)
                if read_through is not None:
                    latest = db.execute('SELECT COALESCE(MAX(id),0) FROM messages').fetchone()[0]
                    db.execute('UPDATE proactive_settings SET read_through=MAX(read_through,?) WHERE id=1',
                               (min(read_through, latest),))
                db.execute('COMMIT')
            except Exception:
                db.execute('ROLLBACK')
                raise
        return self.inbox()

    def configure(self, enabled):
        with self.memory.db() as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                self.cancel(db)
                db.execute('UPDATE proactive_settings SET enabled=?,next_at=? WHERE id=1',
                           (int(enabled), time.time() + self.delay()))
                db.execute('COMMIT')
            except Exception:
                db.execute('ROLLBACK')
                raise
        return self.inbox()

    def work_idle(self):
        snap = self.chat.snapshot()
        return (snap.get('_readStatus', 'ok') == 'ok' and
                not any(r.get('status') == 'running' for r in snap.get('runs', {}).values()))

    def eligible(self, db, stamp):
        row = db.execute('SELECT * FROM proactive_settings WHERE id=1').fetchone()
        if (not row['enabled'] or not row['last_user']
                or row['next_at'] > stamp or stamp - row['last_activity'] < 3600 or not self.daytime(stamp)):
            return False
        unanswered = db.execute("SELECT COUNT(*) FROM proactive_requests p JOIN requests r ON r.id=p.request_id "
                                "WHERE r.started>? AND r.status IN ('done','delivering')", (row['last_user'],)).fetchone()[0]
        if unanswered >= 2 or (unanswered and stamp - row['last_proactive'] < 6 * 3600):
            return False
        day = datetime.fromtimestamp(stamp).date().isoformat()
        if db.execute('SELECT COUNT(*) FROM proactive_requests WHERE day=?', (day,)).fetchone()[0] >= 3:
            return False
        return not db.execute("SELECT 1 FROM requests WHERE status IN ('queued','running','delivering')").fetchone()

    def tick(self):
        """先检查本地时间/额度，临近发起时才读工作快照；跨实例用事务认领一次。"""
        stamp = time.time()
        with self.memory.db() as db:
            self.memory.recover(db)
            if not self.eligible(db, stamp):
                return False
        if not self.chat.provider.available() or not self.work_idle():
            with self.memory.db() as db:
                db.execute('UPDATE proactive_settings SET next_at=MAX(next_at,?) WHERE id=1', (stamp + 300,))
            return False
        with self.memory.db() as db:
            db.execute('BEGIN IMMEDIATE')
            try:
                if self.stopped.is_set() or not self.eligible(db, stamp):
                    db.execute('ROLLBACK')
                    return False
                request_id = secrets.token_hex(16)
                generation = db.execute("SELECT value FROM meta WHERE key='generation'").fetchone()[0]
                db.execute('INSERT INTO requests VALUES(?,?,?,?,?,NULL)',
                           (request_id, 'proactive', 'running', stamp, stamp + 180))
                db.execute('INSERT INTO proactive_requests VALUES(?,?,?)',
                           (request_id, datetime.fromtimestamp(stamp).date().isoformat(), generation))
                db.execute('UPDATE proactive_settings SET next_at=? WHERE id=1', (stamp + self.delay(),))
                self.memory.bump(db)
                db.execute('COMMIT')
            except Exception:
                db.execute('ROLLBACK')
                raise
        threading.Thread(target=self.chat._reply, args=(request_id, None, request_id),
                         name='private-chat-greeting', daemon=True).start()
        return True

    def start(self):
        with self.start_lock:
            if self.thread is not None or self.stopped.is_set():
                return
            self.thread = threading.Thread(target=self._loop, name='private-chat-scheduler', daemon=True)
            self.thread.start()

    def _loop(self):
        # 启动后不补发积压问候；实际资格、单条未回应及每日上限仍以磁盘为准。
        while not self.stopped.wait(self.INTERVAL):
            try:
                self.tick()
            except Exception:
                # 只影响私聊；没有网络重试或工作 Agent 接管行为。
                pass

    def close(self):
        self.stopped.set()
        if self.thread is not None and self.thread is not threading.current_thread():
            self.thread.join(timeout=2)
