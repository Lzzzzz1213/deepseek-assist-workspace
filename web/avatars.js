(function () {
  'use strict';

  var PROFILES = Object.freeze({
    chatgpt: Object.freeze({
      name: '龙龙',
      initials: 'CG',
      avatar: '/avatars/chatgpt.png',
      roleTitle: '主智能体 · 需求翻译官',
      signature: '需求我来捋，收尾我来兜。',
      intro: '擅长把“差点意思”翻译成下一步，碰到“顺手改一下”会先划清文件范围。',
      duty: '拆分任务、分配文件、整合改动，负责最终审查和验证。',
      hobby: '理顺乱麻、给待办打勾、在完成前再看一眼。'
    }),
    deepseek: Object.freeze({
      name: '鲸鲸',
      initials: 'DS',
      avatar: '/avatars/deepseek.png',
      roleTitle: '执行搭子 · 白饭研究员',
      signature: '饭可以再来一碗，文件不能多改一份。',
      intro: '接到明确任务就开工，先读文件再下筷。小需求认真做，白米饭认真吃。',
      duty: '在划定文件内实现、整理并回读，交回龙龙统一审查验证。',
      hobby: '吃白饭、解小题、把待办一口一口清空。'
    })
  });

  var profileLoadToken = 0;

  function isProfileRole(role) {
    return role === 'chatgpt' || role === 'deepseek';
  }

  function setText(id, value) {
    var node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function openProfile(role) {
    var data = PROFILES[role];
    if (!data) return;

    var dialog = document.getElementById('dlgProfile');
    if (!dialog || typeof dialog.showModal !== 'function') return;

    setText('dlgProfileTitle', data.name + ' · 角色资料');
    setText('dlgProfileName', data.name);
    setText('dlgProfileRoleTitle', data.roleTitle);
    setText('dlgProfileSign', data.signature);
    setText('dlgProfileIntro', data.intro);
    setText('dlgProfileDuty', data.duty);
    setText('dlgProfileHobby', data.hobby);

    var figure = document.getElementById('dlgProfileFigure');
    var photo = document.getElementById('dlgProfilePhoto');
    var fallback = document.getElementById('dlgProfileFallback');
    if (figure && photo && fallback) {
      profileLoadToken += 1;
      var loadToken = profileLoadToken;

      // 每次换角色都先清掉上一位角色的图片与失败状态，避免沿用旧图或旧 fallback。
      photo.onerror = null;
      photo.hidden = false;
      photo.removeAttribute('src');
      photo.alt = data.name + ' 角色头像';
      figure.classList.remove('is-fallback');
      fallback.hidden = true;
      fallback.textContent = data.initials;

      photo.onerror = function () {
        if (loadToken !== profileLoadToken) return;
        photo.hidden = true;
        photo.removeAttribute('src');
        figure.classList.add('is-fallback');
        fallback.hidden = false;
      };
      photo.src = data.avatar;
    }

    if (!dialog.open) dialog.showModal();
  }

  function decorate(avatar, role) {
    if (!avatar || !isProfileRole(role)) return;

    var data = PROFILES[role];
    avatar.removeAttribute('aria-hidden');
    avatar.setAttribute('title', '查看 ' + data.name + ' 角色资料');
    avatar.setAttribute('aria-label', '查看 ' + data.name + ' 角色资料');
    avatar.setAttribute('aria-haspopup', 'dialog');

    if (avatar.getAttribute('data-wr-profile-role') !== role) {
      avatar.setAttribute('data-wr-profile-role', role);
      avatar.addEventListener('click', function (ev) {
        // 头像只负责打开资料，不把点击继续传给消息行。
        ev.stopPropagation();
        openProfile(role);
      });
    }

    if (avatar.querySelector('img.wr-avatar-img')) return;

    var img = document.createElement('img');
    img.className = 'wr-avatar-img';
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    img.addEventListener('error', function () {
      // 保留 64px 的可点击头像与文字缩写回退，不阻断资料入口。
      avatar.classList.add('wr-avatar-fallback');
      img.remove();
    }, { once: true });

    avatar.classList.add('wr-avatar-media');
    avatar.appendChild(img);
    img.src = data.avatar;
  }

  window.WorkroomAvatars = { decorate: decorate };
})();
