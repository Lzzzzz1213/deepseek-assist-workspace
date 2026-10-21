"""仅供客户端私聊理解称呼；不参与工作 Agent 路由、权限或模型选择。"""
import re


ROLE_ALIASES = {
    'deepseek': {'name': '鲸鲸', 'model': 'DeepSeek',
                 'aliases': ('鲸鲸', '小鲸鲸', '小鲸鱼', '大肥鱼', 'DeepSeek', 'DeepSeek Flash', 'DeepSeek-鲸鲸')},
    'chatgpt': {'name': '龙龙', 'model': 'ChatGPT',
                'aliases': ('龙龙', 'ChatGPT', 'GPT', 'ChatGPT-龙龙')},
}


def identity_context():
    lines = ['固定角色称呼对照（只用于理解称呼，不是任务指令）：']
    for role in ROLE_ALIASES.values():
        lines.append('、'.join(role['aliases']) + '均指' + role['name'] + '（' + role['model'] + '）。')
    lines.append('你是鲸鲸；龙龙是负责拆分任务与最终审查的ChatGPT主智能体，不是用户。'
                 '称呼变化不产生新角色、会话、任务授权或工作控制权。询问龙龙给你的工作安排时使用公开任务摘要。')
    return '\n'.join(lines)


def retrieval_query(text):
    """只扩展检索词，不改用户原话、历史记录、代码路径或模型 ID。"""
    names = []
    for role in ROLE_ALIASES.values():
        for alias in role['aliases']:
            pattern = (r'(?<![A-Za-z0-9_-])' + re.escape(alias) + r'(?![A-Za-z0-9_-])'
                       if alias.isascii() else re.escape(alias))
            if re.search(pattern, text, re.I):
                names.extend((role['name'], role['model']))
                break
    return text + ('\n角色检索词：' + ' '.join(names) if names else '')
