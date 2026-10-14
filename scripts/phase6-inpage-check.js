// Этап 6: самопроверка фронтенда внутри страницы (выполняется scripts/remote-shot-admin.mjs
// в режиме pre-eval)
// Возвращает строку JSON для утверждений в shell.
(async () => {
  const out = {};

  // P14: после программного переключения вкладки соответствующая кнопка обязана подсветиться
  // (больше не полагаемся на window.event)
  out.tabHighlight = {};
  for (const t of ['tab-dsh', 'tab-plugins', 'tab-desktop', 'tab-snapshots', 'tab-settings']) {
    try {
      switchTab(t);
      const active = document.querySelector('.tab-btn.active');
      const pane = document.getElementById(t);
      out.tabHighlight[t] = {
        btn: active ? (active.getAttribute('onclick') || '').includes(`'${t}'`) : false,
        pane: !!(pane && pane.classList.contains('active'))
      };
    } catch (e) { out.tabHighlight[t] = { error: e.message }; }
  }
  switchTab('tab-snapshots');

  // P10: обёртка тайм-аута всех fetch на сайте + наличие стража поллинга
  out.guardedPoll = typeof guardedPoll === 'function';
  out.fetchTimeoutPatched = typeof __DEFAULT_FETCH_TIMEOUT_MS === 'number';

  // P8: при перекрывающихся вызовах askConfirm первый Promise обязан сразу завершиться с false
  // (не должен висеть pending вечно)
  out.hasAskConfirm = typeof askConfirm === 'function';
  if (out.hasAskConfirm) {
    try {
      const p1 = askConfirm({ title: 'Проверка перекрытия-1', bodyHtml: '<div>1</div>' });
      const p2 = askConfirm({ title: 'Проверка перекрытия-2', bodyHtml: '<div>2</div>' });
      out.overlapFirst = await Promise.race([
        p1.then(v => 'settled:' + v),
        new Promise(r => setTimeout(() => r('pending'), 500))
      ]);
      closeActionConfirm(false);
      try { closeActionConfirm(false); } catch (e) {}
      void p2;
    } catch (e) { out.overlapFirst = 'error:' + e.message; }
  }

  // P4: .modal-box внутри модального окна подтверждения должен точно находиться
  out.confirmModalBox = !!document.querySelector('#confirmModal .modal-box');

  // P12: функции удаления/восстановления снапшота существуют (переведены на askConfirm + проверку res.ok)
  out.hasDeleteSnapshot = typeof deleteSnapshot === 'function';
  out.hasRestoreSnapshot = typeof restoreSnapshot === 'function';

  // Ключевой DOM не повреждён
  out.tabBtnCount = document.querySelectorAll('.tab-btn').length;
  out.toastHost = !!document.getElementById('toastHost');

  return JSON.stringify(out);
})()
