const tbody = document.getElementById('overrides');
const empty = document.getElementById('empty');

/**
 * Shows the user's own climb names.
 * @param {Array<{ name: string, top: number[] }>} list
 * @returns {void}
 */
function render(list) {
  tbody.textContent = '';
  empty.hidden = list.length > 0;
  list.forEach((o, i) => {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = o.name;
    const where = document.createElement('td');
    const a = document.createElement('a');
    a.href = `https://www.openstreetmap.org/?mlat=${o.top[0]}&mlon=${o.top[1]}#map=15/${o.top[0]}/${o.top[1]}`;
    a.target = '_blank';
    a.textContent = `${o.top[0].toFixed(4)}, ${o.top[1].toFixed(4)}`;
    where.appendChild(a);
    const act = document.createElement('td');
    const del = document.createElement('button');
    del.textContent = 'Remove';
    del.onclick = () => {
      const next = list.filter((_, j) => j !== i);
      chrome.storage.sync.set({ overrides: next }, () => render(next));
    };
    act.appendChild(del);
    tr.append(name, where, act);
    tbody.appendChild(tr);
  });
}

chrome.storage.sync.get({ overrides: [] }, (v) => render(v.overrides));


document.getElementById('clear').onclick = () => {
  chrome.runtime.sendMessage({ type: 'clearCache' }, () => {
    document.getElementById('cleared').hidden = false;
  });
};
