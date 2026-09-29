(() => {
  const board = document.getElementById('board');
  if (!board) return;

  const FIRST_HOUR = 7;
  const HOURS = 11;
  const WORKDAY = 8;
  const days = [
    { label: 'MON', date: 9, long: 'Monday, March 9' },
    { label: 'TUE', date: 10, long: 'Tuesday, March 10' },
    { label: 'WED', date: 11, long: 'Wednesday, March 11' },
    { label: 'THU', date: 12, long: 'Thursday, March 12' },
    { label: 'FRI', date: 13, long: 'Friday, March 13' },
  ];
  const TODAY = 3;
  const fmt = hours => `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  const clock = value => `${String(Math.floor(value)).padStart(2, '0')}:${String(Math.round((value % 1) * 60)).padStart(2, '0')}`;

  /* ---------- Team grid (made-up people and issues) ---------- */
  const issues = {
    'APP-214': 'Checkout retry banner', 'APP-219': 'Crash on empty cart', 'APP-221': 'Retry banner analytics events',
    'APP-230': 'Order history pagination', 'APP-233': 'Saved addresses form validation',
    'WEB-87': 'Pricing page copy review', 'WEB-91': 'Blog index performance', 'WEB-95': 'Cookie banner translations',
    'OPS-31': 'Nightly import job alerts', 'DOC-12': 'API changelog for v2.3',
  };
  const mayaLogs = [
    [[7.5, 'OPS-31', 1.5, 'Tuned alert thresholds'], [9, 'APP-214', 3], [13, 'WEB-87', 1], [14, 'APP-214', 2.5, 'Copy and retry states']],
    [[9, 'APP-219', 2, 'Reproduced with an empty session'], [11, 'WEB-87', 1], [13.5, 'APP-214', 3]],
    [[9, 'DOC-12', 1.5], [10, 'WEB-87', 1, 'Review call'], [11, 'APP-214', 1.5], [13, 'APP-221', 4]],
    [[9, 'APP-219', 3, 'Guard and regression test'], [13, 'OPS-31', 1.5]],
    [],
  ];
  const people = [
    { name: 'Amara Okafor', initials: 'AO', hours: [8, 8, 7.5, 6, 0], pool: ['APP-230', 'APP-233', 'WEB-91'] },
    { name: 'Jonas Weber', initials: 'JW', hours: [8, 8, 8, 8, 0], pool: ['APP-219', 'APP-214', 'WEB-95'] },
    { name: 'Lucía Romero', initials: 'LR', hours: [8, 5, 8, 8, 0], pool: ['WEB-91', 'WEB-95', 'WEB-87'] },
    { name: 'Maya Chen', initials: 'MC', hours: [8, 6, 8, 4.5, 0], pinned: true, logs: mayaLogs },
    { name: 'Sam Whitfield', initials: 'SW', hours: [7, 8, 8, 8, 0], pool: ['APP-233', 'APP-221', 'WEB-87'] },
    { name: 'Tomás Ilves', initials: 'TI', hours: [0, 0, 0, 0, 0], pinned: true, pool: [] },
  ];
  const logsFor = (person, dayIndex) => {
    if (person.logs) return person.logs[dayIndex];
    let left = person.hours[dayIndex];
    const starts = [9, 13, 16];
    const logs = [];
    for (let i = 0; left > 0 && i < starts.length; i += 1) {
      const chunk = Math.min(left, 3);
      logs.push([starts[i], person.pool[(i + dayIndex) % person.pool.length], chunk]);
      left -= chunk;
    }
    return logs;
  };
  const missingFor = (person, dayIndex) => (dayIndex > TODAY ? 0 : Math.max(0, WORKDAY - person.hours[dayIndex]));

  const body = document.getElementById('team-body');
  if (body) {
    body.innerHTML = people.map((person, row) => {
      const total = person.hours.reduce((sum, value) => sum + value, 0);
      const cells = person.hours.map((hours, dayIndex) => {
        const missing = missingFor(person, dayIndex);
        const label = `${person.name}, ${days[dayIndex].long}: ${hours ? `${fmt(hours)} logged` : 'no time logged'}${missing ? `, ${fmt(missing)} missing` : ''}`;
        return `<td class="hc${hours ? '' : ' empty'}${missing ? ' is-short' : ''}"><button type="button" data-person="${row}" data-day="${dayIndex}" aria-label="${label}">${hours ? fmt(hours) : '–'}${missing ? `<small aria-hidden="true">−${fmt(missing)}</small>` : ''}<span class="cm" style="--p:${Math.min(1, hours / WORKDAY)}" aria-hidden="true"></span></button></td>`;
      }).join('');
      const pin = person.pinned ? '<svg class="ic pin" role="img" aria-label="Pinned"><use href="#i-pin"/></svg>' : '';
      return `<tr><th scope="row" class="pc"><span class="person"><i class="av" aria-hidden="true">${person.initials}</i><span>${person.name}</span>${pin}</span></th>${cells}<td class="tc">${fmt(total)}</td></tr>`;
    }).join('');
  }

  /* ---------- Replica state ---------- */
  const calView = board.querySelector('.b-cal');
  const teamView = board.querySelector('.b-team');
  const switches = [...board.querySelectorAll('[data-action="focus"]')];
  const themeButton = board.querySelector('[data-action="theme"]');
  const detailModal = board.querySelector('.b-modal-detail');
  const slot = board.querySelector('.slot');
  const slotTime = slot.querySelector('.slot-time');
  const dayValue = board.querySelector('.b-day-val');
  const timeValue = board.querySelector('.b-time-val');
  const thursday = board.querySelector('.lane[data-day="THU 12"]');
  let lastTrigger = null;

  const setState = next => {
    const state = { view: board.dataset.view, focus: board.dataset.focus, dialog: board.dataset.dialog, ...next };
    board.dataset.view = state.view;
    board.dataset.focus = state.focus;
    board.dataset.dialog = state.dialog;
    calView.inert = state.view !== 'calendar' || state.dialog !== 'none';
    teamView.inert = state.view !== 'team' || state.dialog !== 'none';
    switches.forEach(button => button.setAttribute('aria-checked', String(state.focus === 'on')));
    detailModal.setAttribute('aria-hidden', String(state.dialog !== 'detail'));
    if (state.dialog !== 'detail' && detailModal.contains(document.activeElement) && lastTrigger) lastTrigger.focus();
  };

  const placeSlot = (lane, start) => {
    if (slot.parentElement !== lane) lane.append(slot);
    slot.style.setProperty('--s', start);
    slotTime.textContent = clock(start);
  };
  const presetLog = (lane = thursday, start = 14.5) => {
    placeSlot(lane, start);
    dayValue.textContent = lane.dataset.day;
    timeValue.textContent = clock(start);
  };

  const stepStates = [
    { view: 'calendar', focus: 'off', dialog: 'none' },
    { view: 'calendar', focus: 'off', dialog: 'none' },
    { view: 'calendar', focus: 'off', dialog: 'log' },
    { view: 'calendar', focus: 'on', dialog: 'none' },
    { view: 'team', focus: 'on', dialog: 'none' },
    { view: 'tickets', focus: 'off', dialog: 'none' },
    { view: 'tickets', focus: 'off', dialog: 'export' },
  ];

  /* ---------- Controls inside the replica ---------- */
  board.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'focus') setState({ focus: board.dataset.focus === 'on' ? 'off' : 'on' });
    else if (action === 'theme') {
      const dark = board.dataset.theme !== 'dark';
      board.dataset.theme = dark ? 'dark' : 'light';
      themeButton.setAttribute('aria-pressed', String(dark));
    } else if (action === 'log') { presetLog(); setState({ view: 'calendar', dialog: 'log' }); }
    else if (action === 'export') setState({ dialog: 'export' });
    else if (action === 'close') setState({ dialog: 'none' });
    else if (event.target.classList.contains('b-modal')) setState({ dialog: 'none' });

    const cell = event.target.closest('.hc button');
    if (cell) openDetail(cell);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && board.dataset.dialog !== 'none') setState({ dialog: 'none' });
  });

  function openDetail(button) {
    const person = people[Number(button.dataset.person)];
    const dayIndex = Number(button.dataset.day);
    const hours = person.hours[dayIndex];
    const missing = missingFor(person, dayIndex);
    const logs = logsFor(person, dayIndex);
    document.getElementById('detail-av').textContent = person.initials;
    document.getElementById('detail-name').textContent = person.name;
    document.getElementById('detail-meta').textContent = `${days[dayIndex].long} · ${fmt(hours)} logged${missing ? ` · ${fmt(missing)} missing` : ''}`;
    const list = document.getElementById('detail-list');
    list.innerHTML = logs.length
      ? logs.map(([start, key, duration, note]) => `<li><div><b>${key}</b><span>${issues[key]}</span><em>${fmt(duration)}</em></div><small>${clock(start)}${note ? ` · ${note}` : ''}</small></li>`).join('')
      : '';
    list.hidden = !logs.length;
    let empty = detailModal.querySelector('.b-detail-empty');
    if (!logs.length && !empty) {
      empty = document.createElement('p');
      empty.className = 'b-detail-empty';
      list.after(empty);
    }
    if (empty) { empty.textContent = 'No time logged on this day.'; empty.hidden = !!logs.length; }
    lastTrigger = button;
    setState({ dialog: 'detail' });
    detailModal.querySelector('.b-close').focus({ preventScroll: true });
  }

  /* ---------- Click an hour ---------- */
  const slotFromPointer = (lane, event) => {
    const rect = lane.getBoundingClientRect();
    const hour = FIRST_HOUR + ((event.clientY - rect.top) / rect.height) * HOURS;
    return Math.min(Math.max(Math.floor(hour * 4) / 4, FIRST_HOUR), FIRST_HOUR + HOURS - 1);
  };
  board.querySelectorAll('.lane').forEach(lane => {
    lane.addEventListener('mousemove', event => {
      if (board.dataset.view !== 'calendar' || board.dataset.dialog !== 'none' || event.target.closest('.wl')) {
        board.classList.remove('is-hovering');
        return;
      }
      placeSlot(lane, slotFromPointer(lane, event));
      board.classList.add('is-hovering');
    });
    lane.addEventListener('mouseleave', () => board.classList.remove('is-hovering'));
    lane.addEventListener('click', event => {
      if (board.dataset.view !== 'calendar' || board.dataset.dialog !== 'none' || event.target.closest('.wl')) return;
      const start = slotFromPointer(lane, event);
      presetLog(lane, start);
      board.classList.remove('is-hovering');
      setState({ dialog: 'log' });
    });
  });

  /* ---------- Scroll story ---------- */
  const steps = [...document.querySelectorAll('[data-step]')];
  const railSteps = [...document.querySelectorAll('.step')];
  const stepsWrap = document.querySelector('.steps');
  let activeStep = -1;
  const activate = index => {
    if (index === activeStep) return;
    activeStep = index;
    if (index === 2) presetLog();
    setState(stepStates[index]);
    railSteps.forEach(step => {
      const n = Number(step.dataset.step);
      step.classList.toggle('is-active', n === index);
      step.classList.toggle('is-past', n < index);
    });
  };
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => { if (entry.isIntersecting) activate(Number(entry.target.dataset.step)); });
    }, { rootMargin: '-62% 0px -30% 0px' });
    steps.forEach(step => observer.observe(step));
  }
  setState(stepStates[0]);

  let ticking = false;
  const updateProgress = () => {
    ticking = false;
    if (!stepsWrap) return;
    const rect = stepsWrap.getBoundingClientRect();
    const progress = Math.min(1, Math.max(0, (window.innerHeight * .5 - rect.top) / rect.height));
    stepsWrap.style.setProperty('--progress', progress.toFixed(4));
  };
  window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(updateProgress); } }, { passive: true });
  window.addEventListener('resize', updateProgress);
  updateProgress();

  /* ---------- Copy commands ---------- */
  document.querySelectorAll('[data-copy]').forEach(button => {
    const label = button.querySelector('.copy-label');
    button.addEventListener('click', async () => {
      const source = document.querySelector(button.dataset.copy);
      if (!source) return;
      try {
        await navigator.clipboard.writeText(source.textContent.trim());
        label.textContent = 'Copied';
      } catch {
        label.textContent = 'Select and copy';
      }
      button.classList.add('is-done');
      window.setTimeout(() => { label.textContent = 'Copy commands'; button.classList.remove('is-done'); }, 2200);
    });
  });

})();

/* Download links: resolve real assets from the latest GitHub release and suggest the visitor's platform. */
(() => {
  const releasesUrl = 'https://github.com/defrimhasani/trackline/releases/latest';
  const agent = `${navigator.userAgentData?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent}`.toLowerCase();
  const platform = /mac|iphone|ipad/.test(agent) ? 'mac' : /win/.test(agent) ? 'windows' : /linux|x11/.test(agent) ? 'linux' : '';
  const primary = { mac: { asset: 'aarch64.dmg', label: 'Download for macOS' }, windows: { asset: 'x64-setup.exe', label: 'Download for Windows' }, linux: { asset: '.AppImage', label: 'Download for Linux' } }[platform];

  document.querySelectorAll(`.platform[data-platform="${platform}"]`).forEach(row => row.classList.add('is-yours'));
  const heroLink = document.querySelector('[data-download="auto"]');
  const heroLabel = document.querySelector('[data-download-label]');
  if (primary && heroLabel) heroLabel.textContent = primary.label;

  fetch('https://api.github.com/repos/defrimhasani/trackline/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
    .then(response => response.ok ? response.json() : Promise.reject(response.status))
    .then(release => {
      const find = suffix => release.assets.find(asset => asset.name.endsWith(suffix) && !asset.name.endsWith('.sig'));
      document.querySelectorAll('[data-asset]').forEach(link => {
        const asset = find(link.dataset.asset);
        if (asset) { link.href = asset.browser_download_url; link.title = `${asset.name} · ${(asset.size / 1048576).toFixed(1)} MB`; }
      });
      const heroAsset = primary && find(primary.asset);
      if (heroLink && heroAsset) heroLink.href = heroAsset.browser_download_url;
      const version = release.tag_name;
      document.querySelectorAll('[data-release-version]').forEach(node => { node.textContent = `Latest release: ${version}.`; });
      const note = document.querySelector('[data-release-note]');
      if (note) {
        note.textContent = `${version} · Free for macOS, Windows and Linux. `;
        if (platform === 'mac') { const intel = find('x64.dmg'); if (intel) { const link = document.createElement('a'); link.href = intel.browser_download_url; link.textContent = 'Intel Mac?'; note.append(link); } }
      }
    })
    .catch(() => { if (heroLink) heroLink.href = releasesUrl; });
})();
