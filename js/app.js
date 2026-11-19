const $ = id => document.getElementById(id);
const PREFIX = 'espelho-pin-';
/*
  Conexão WebRTC: STUN é gratuito, mas não resolve todas as redes.
  TURN deve ser fornecido por um serviço seguro com credenciais temporárias.
  Quando houver um endpoint seu, ele pode definir window.ESPelhoIceServers antes deste script.
  Não coloque usuário/senha permanentes de TURN neste arquivo público.
*/
const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    ...(Array.isArray(window.ESPelhoIceServers) ? window.ESPelhoIceServers : [])
  ],
  iceTransportPolicy: 'all'
};
const MAX_TRANSFER = 60 * 1024 * 1024;
const CHUNK_SIZE = 16 * 1024;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const go = h => { location.hash = h; location.reload(); };
const msg = (el, t, bad) => { el.textContent = t; el.classList.toggle('err', !!bad); };
let peer, conn, call, localStream, facing = 'environment', pin = '';

if (typeof Peer === 'undefined'){
  document.body.innerHTML = '<main><h1>Sem conexão com a biblioteca</h1><p>Verifique a internet e recarregue a página.</p></main>';
} else {
  if (typeof pdfjsLib !== 'undefined') pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  if (location.hash === '#projetor') projetor();
  else if (location.hash.startsWith('#enviar')) enviar();
}

/* ================= PROJETOR ================= */
function projetor(){
  $('menu').hidden = true; $('proj').hidden = false;
  const st = $('st'), stage = $('stage'), root = $('proj');
  const tiles = new Map(), pend = new Map(), transfers = new Map();
  let focus = null, som = false, grade = false;

  function refresh(){
    root.classList.toggle('live', tiles.size > 0);
    root.classList.toggle('grid', grade);
    root.classList.toggle('focus', !grade);
    const ch = $('chips'); ch.innerHTML = '';
    tiles.forEach((t, id) => {
      const b = document.createElement('button');
      b.className = 'sec'; b.textContent = (id === focus ? '● ' : '') + t.name;
      b.onclick = () => { focus = id; refresh(); };
      const x = document.createElement('button');
      x.className = 'sec'; x.textContent = '×'; x.setAttribute('aria-label', 'Remover ' + t.name);
      x.onclick = () => { t.conn.close(); drop(id); };
      ch.append(b, x);
    });
    tiles.forEach((t, id) => t.el.classList.toggle('on', id === focus));
  }
  function drop(id){
    const t = tiles.get(id); if (!t) return;
    for (const [transferId, transfer] of transfers) if (transfer.peerId === id) transfers.delete(transferId);
    t.urls.forEach(u => URL.revokeObjectURL(u));
    t.el.remove(); tiles.delete(id);
    if (focus === id) focus = [...tiles.keys()].pop() || null;
    refresh();
  }
  function criar(c, name){
    const el = document.createElement('div'); el.className = 'tile';
    const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = name;
    const body = document.createElement('div'); body.className = 'body';
    el.append(cap, body); stage.append(el);
    tiles.set(c.peer, { name, conn: c, el, cap, body, urls: [], deck: null });
    reset(c.peer); focus = c.peer; refresh();
    c.send({ t: 'ok' }); msg(st, name + ' conectou.');
  }
  function reset(id){
    const t = tiles.get(id); if (!t) return;
    const p = document.createElement('p'); p.className = 'dim'; p.textContent = 'Conectado. Aguardando conteúdo…';
    put(id, p);
  }
  function put(id, el, urls){
    const t = tiles.get(id); if (!t) return;
    t.urls.forEach(u => URL.revokeObjectURL(u));
    t.urls = urls || []; t.deck = null; t.cap.textContent = t.name;
    t.body.replaceChildren(el); focus = id; refresh();
  }
  function pedido(c, name){
    pend.set(c.peer, c);
    const box = document.createElement('div'); box.className = 'ask'; box.id = 'p-' + c.peer;
    const s = document.createElement('span'); s.textContent = name + ' quer conectar';
    const ok = document.createElement('button'); ok.textContent = 'Aceitar';
    const no = document.createElement('button'); no.className = 'sec'; no.textContent = 'Recusar';
    ok.onclick = () => { limparPedido(c.peer); criar(c, name); };
    no.onclick = () => { limparPedido(c.peer); c.send({ t: 'no' }); setTimeout(() => c.close(), 300); };
    box.append(s, ok, no); $('pend').append(box);
  }
  function limparPedido(id){ pend.delete(id); const b = document.getElementById('p-' + id); if (b) b.remove(); }

  function onData(id, d){
    if (!tiles.has(id) || !d) return;
    if (d.t === 'transfer-start') return iniciarRecebimento(id, d);
    if (d.t === 'transfer-chunk') return receberBloco(id, d);
    if (d.t === 'transfer-end') return finalizarRecebimento(id, d);

    if (d.t === 'text'){
      const m = document.createElement('div'); m.className = 'msg'; m.textContent = String(d.text).slice(0, 300); put(id, m);
    } else if (d.t === 'link') link(id, d.url);
    else if (d.t === 'file') arquivo(id, d);
    else if (d.t === 'deck') deck(id, d);
    else if (d.t === 'nav') nav(id, d);
  }
  function iniciarRecebimento(peerId, d){
    if (typeof d.id !== 'string' || d.id.length > 80 || !Array.isArray(d.parts) || !d.parts.length || d.parts.length > 100) return;
    const total = d.parts.reduce((sum, part) => sum + (Number(part.size) || 0), 0);
    if (!Number.isSafeInteger(total) || total < 0 || total > MAX_TRANSFER) {
      const t = tiles.get(peerId); if (t) t.conn.send({ t: 'transfer-error', id: d.id, message: 'Transferência acima do limite de 60 MB.' });
      return;
    }
    transfers.set(d.id, { peerId, kind: d.kind, meta: d.meta || {}, parts: d.parts.map(part => ({ name: String(part.name || ''), type: String(part.type || 'application/octet-stream'), size: Number(part.size) || 0, chunks: [], received: 0 })), total, received: 0 });
    msg(st, 'Recebendo arquivo… 0%');
  }
  function receberBloco(peerId, d){
    const tr = transfers.get(d.id);
    if (!tr || tr.peerId !== peerId || !Number.isInteger(d.part) || !tr.parts[d.part] || !(d.data instanceof ArrayBuffer)) return;
    const part = tr.parts[d.part];
    if (part.received + d.data.byteLength > part.size || tr.received + d.data.byteLength > tr.total) { transfers.delete(d.id); return; }
    part.chunks.push(d.data); part.received += d.data.byteLength; tr.received += d.data.byteLength;
    const pct = tr.total ? Math.floor(tr.received / tr.total * 100) : 100;
    msg(st, 'Recebendo arquivo… ' + pct + '%');
  }
  async function finalizarRecebimento(peerId, d){
    const tr = transfers.get(d.id);
    if (!tr || tr.peerId !== peerId) return;
    transfers.delete(d.id);
    if (tr.parts.some(part => part.received !== part.size)) { msg(st, 'Transferência incompleta. Peça para enviar novamente.', true); return; }
    try {
      const buffers = await Promise.all(tr.parts.map(async part => new Blob(part.chunks).arrayBuffer()));
      let message;
      if (tr.kind === 'file') message = { t: 'file', name: tr.meta.name, type: tr.meta.type, data: buffers[0] };
      else if (tr.kind === 'deck-pdf') message = { t: 'deck', kind: 'pdf', data: buffers[0] };
      else if (tr.kind === 'deck-images') message = { t: 'deck', kind: 'img', pages: buffers.map((data, i) => ({ type: tr.parts[i].type, data })) };
      else return;
      onData(peerId, message);
    } catch (err) { msg(st, 'Falha ao montar o arquivo recebido.', true); }
  }
  function arquivo(id, d){
    const type = d.type || '', url = URL.createObjectURL(new Blob([d.data], { type: type || 'application/octet-stream' }));
    let el;
    if (type.startsWith('image/')){ el = new Image(); el.src = url; el.alt = d.name; }
    else if (type.startsWith('video/')){ el = document.createElement('video'); el.src = url; el.controls = true; el.autoplay = true; el.playsInline = true; }
    else if (type.startsWith('audio/')){ el = document.createElement('audio'); el.src = url; el.controls = true; el.autoplay = true; }
    else if (type === 'application/pdf'){ el = document.createElement('iframe'); el.src = url; el.title = d.name; }
    else { el = document.createElement('a'); el.href = url; el.download = d.name; el.className = 'btn'; el.textContent = 'Baixar ' + d.name; }
    put(id, el, [url]); msg(st, 'Recebido: ' + d.name);
  }
  function embedUrl(u){
    const h = u.hostname.replace(/^www\./, '');
    let v = null;
    if (h === 'youtu.be') v = u.pathname.split('/').filter(Boolean)[0];
    else if (h === 'youtube.com' || h.endsWith('.youtube.com')) v = u.searchParams.get('v');
    return v && /^[A-Za-z0-9_-]{11}$/.test(v) ? 'https://www.youtube.com/embed/' + v + '?autoplay=1' : null;
  }
  function link(id, raw){
    let u; try { if (typeof raw !== 'string' || raw.length > 2048) throw 0; u = new URL(raw); if (!/^https?:$/.test(u.protocol) || !u.hostname) throw 0; } catch (e) { msg(st, 'Link inválido ou não permitido.', true); return; }
    const emb = embedUrl(u);
    if (emb){ const f = document.createElement('iframe'); f.src = emb; f.allow = 'autoplay; fullscreen'; f.allowFullscreen = true; return put(id, f); }
    const box = document.createElement('div'); box.className = 'body';
    const p = document.createElement('p'); p.className = 'msg'; p.textContent = u.href;
    const a = document.createElement('a'); a.href = u.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.className = 'btn'; a.textContent = 'Abrir ' + u.hostname;
    const b = document.createElement('button'); b.className = 'sec'; b.textContent = 'Mostrar aqui (alguns sites bloqueiam)';
    b.onclick = () => { const f = document.createElement('iframe'); f.src = u.href; f.referrerPolicy = 'no-referrer'; f.sandbox = 'allow-scripts allow-forms allow-presentation'; put(id, f); };
    box.append(p, a, b); put(id, box);
  }
  async function deck(id, d){
    const t = tiles.get(id);
    try {
      if (d.kind === 'pdf'){
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(d.data) }).promise;
        const c = document.createElement('canvas'); put(id, c);
        t.deck = { pdf, view: c, i: 1, n: pdf.numPages };
      } else {
        const urls = d.pages.map(p => URL.createObjectURL(new Blob([p.data], { type: p.type })));
        const im = new Image(); put(id, im, urls);
        t.deck = { urls, view: im, i: 1, n: urls.length };
      }
      mostrar(id);
    } catch (e) { msg(st, 'Não foi possível abrir os slides.', true); }
  }
  async function mostrar(id){
    const t = tiles.get(id), k = t && t.deck; if (!k) return;
    if (k.busy){ k.again = true; return; }
    k.busy = true;
    try {
      if (k.pdf){
        const pg = await k.pdf.getPage(k.i), vp = pg.getViewport({ scale: 2 });
        k.view.width = vp.width; k.view.height = vp.height;
        await pg.render({ canvasContext: k.view.getContext('2d'), viewport: vp }).promise;
      } else k.view.src = k.urls[k.i - 1];
      t.cap.textContent = t.name + ' – slide ' + k.i + ' de ' + k.n;
      t.conn.send({ t: 'deckinfo', i: k.i, n: k.n });
    } finally { k.busy = false; if (k.again){ k.again = false; mostrar(id); } }
  }
  function nav(id, d){
    const t = tiles.get(id), k = t && t.deck; if (!k) return;
    let i = k.i;
    if (d.cmd === 'next') i++; else if (d.cmd === 'prev') i--; else if (d.cmd === 'goto') i = parseInt(d.n, 10) || 1;
    k.i = Math.min(k.n, Math.max(1, i)); mostrar(id);
  }

  function novoPin(){
    const random = new Uint32Array(1); crypto.getRandomValues(random); const p = String(100000 + (random[0] % 900000));
    if (peer) peer.destroy();
    [...tiles.keys()].forEach(drop);
    [...pend.values()].forEach(c => { try { c.close(); } catch (e) {} });
    pend.clear(); transfers.clear(); $('pend').replaceChildren();
    peer = new Peer(PREFIX + p, { config: ICE });
    peer.on('open', () => {
      $('pin').textContent = p.slice(0, 3) + ' ' + p.slice(3);
      desenharQr(p); msg(st, 'Aguardando os celulares…');
    });
    peer.on('error', e => {
      if (e.type === 'unavailable-id') return novoPin();
      msg(st, 'Erro de conexão: ' + e.type + '. Verifique a internet ou gere outro PIN.', true);
    });
    peer.on('disconnected', () => { msg(st, 'Sinalização desconectada. Tentando reconectar…', true); try { peer.reconnect(); } catch (e) { msg(st, 'Reconexão indisponível. Gere um novo PIN.', true); } });
    peer.on('connection', c => {
      c.on('data', d => {
        if (d && d.t === 'hello'){
          if (tiles.has(c.peer) || pend.has(c.peer)) return;
          const name = String(d.name || '').trim().slice(0, 30) || 'Aluno';
          if ($('apr').checked) pedido(c, name); else criar(c, name);
        } else onData(c.peer, d);
      });
      c.on('close', () => { limparPedido(c.peer); drop(c.peer); });
    });
    peer.on('call', ch => {
      if (!tiles.has(ch.peer)) return ch.close();
      ch.answer();
      ch.on('stream', s => {
        const v = document.createElement('video');
        v.autoplay = true; v.playsInline = true; v.muted = !som; v.srcObject = s; v.dataset.live = '1';
        put(ch.peer, v); msg(st, 'Recebendo transmissão ao vivo.');
      });
      ch.on('close', () => { const t = tiles.get(ch.peer); if (t && t.body.querySelector('[data-live]')) reset(ch.peer); });
    });
  }
  function desenharQr(p){
    const box = $('qr'); box.innerHTML = '';
    if (typeof QRCode === 'undefined' || location.protocol === 'file:') return;
    new QRCode(box, { text: location.href.split('#')[0] + '#enviar-' + p, width: 150, height: 150, colorDark: '#12302a', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
  }

  $('bFull').onclick = () => document.documentElement.requestFullscreen?.();
  $('bSom').onclick = () => {
    som = !som; stage.querySelectorAll('video').forEach(v => v.muted = !som);
    $('bSom').textContent = som ? 'Silenciar' : 'Ativar som';
  };
  $('bGrade').onclick = () => { grade = !grade; $('bGrade').textContent = grade ? 'Ver um por vez' : 'Ver todos em grade'; refresh(); };
  $('bLimpa').onclick = () => { if (focus) reset(focus); };
  $('bNovo').onclick = () => { $('pin').textContent = '······'; $('qr').innerHTML = ''; msg(st, 'Gerando PIN…'); novoPin(); };
  document.addEventListener('keydown', e => {
    if (!focus || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') nav(focus, { cmd: 'next' });
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') nav(focus, { cmd: 'prev' });
  });
  refresh(); novoPin();
}

/* ================= CELULAR / EMISSOR ================= */
function enviar(){
  $('menu').hidden = true; $('send').hidden = false;
  const sst = $('sst');
  if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)){
    $('bTela').disabled = true; $('bTela').textContent = 'Transmitir tela (indisponível neste aparelho)';
  }
  const enviarMsg = o => { try { if (!conn || !conn.open) throw new Error('closed'); conn.send(o); return true; } catch (e) { msg(sst, 'Conexão perdida. Reconecte ao projetor.', true); return false; } };
  function mostrarProgresso(percent, texto){
    $('progressBox').hidden = false; $('progress').value = percent; $('progressText').textContent = texto;
  }
  function ocultarProgresso(){ $('progressBox').hidden = true; $('progress').value = 0; $('progressText').textContent = ''; }
  async function aguardarCanalLivre(){
    const dc = conn && conn.dataChannel;
    if (!dc) { await wait(8); }
    while (conn && conn.open && dc && dc.readyState === 'open' && dc.bufferedAmount > 512 * 1024) await wait(40);
    if (!conn || !conn.open) throw new Error('Conexão encerrada durante o envio.');
  }
  async function enviarTransferencia(kind, meta, files){
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_TRANSFER) throw new Error('O total ultrapassa 60 MB.');
    if (!conn || !conn.open) throw new Error('Conecte-se ao projetor antes de enviar.');
    const id = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
    conn.send({ t: 'transfer-start', id, kind, meta, parts: files.map(file => ({ name: file.name || '', type: file.type || 'application/octet-stream', size: file.size })) });
    let sent = 0;
    for (let part = 0; part < files.length; part++){
      const file = files[part];
      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE){
        await aguardarCanalLivre();
        const data = await file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size)).arrayBuffer();
        conn.send({ t: 'transfer-chunk', id, part, data });
        sent += data.byteLength;
        const pct = total ? Math.floor(sent / total * 100) : 100;
        mostrarProgresso(pct, 'Enviando… ' + pct + '%');
      }
    }
    await aguardarCanalLivre();
    conn.send({ t: 'transfer-end', id });
    mostrarProgresso(100, 'Envio concluído.');
    await wait(900); ocultarProgresso();
  }

  $('bConn').onclick = () => {
    pin = $('pinIn').value.replace(/\D/g, '');
    if (pin.length !== 6) return msg(sst, 'Digite os 6 números do PIN.', true);
    const nome = $('nome').value.trim() || 'Aluno';
    msg(sst, 'Conectando…');
    if (peer) peer.destroy();
    peer = new Peer({ config: ICE });
    peer.on('error', e => msg(sst, e.type === 'peer-unavailable' ? 'PIN não encontrado. Confira o número no projetor.' : 'Erro de conexão: ' + e.type + '. Tente novamente.', true));
    peer.on('disconnected', () => { msg(sst, 'Conexão de sinalização interrompida. Tentando recuperar…', true); try { peer.reconnect(); } catch (e) {} });
    peer.on('open', () => {
      conn = peer.connect(PREFIX + pin, { serialization: 'binary', reliable: true });
      const t = setTimeout(() => msg(sst, 'Não foi possível conectar. Verifique o PIN e a rede.', true), 12000);
      conn.on('open', () => { clearTimeout(t); conn.send({ t: 'hello', name: nome }); msg(sst, 'Aguardando o professor aceitar…'); });
      conn.on('data', d => {
        if (!d) return;
        if (d.t === 'ok'){ $('login').hidden = true; $('acoes').hidden = false; msg(sst, 'Conectado como ' + nome + '.'); }
        else if (d.t === 'no') msg(sst, 'O professor recusou a conexão.', true);
        else if (d.t === 'deckinfo') $('dinfo').textContent = d.i + ' / ' + d.n;
        else if (d.t === 'transfer-error') msg(sst, d.message || 'O projetor não conseguiu receber o arquivo.', true);
      });
      conn.on('close', () => { parar(); ocultarProgresso(); $('login').hidden = false; $('acoes').hidden = true; msg(sst, 'Conexão encerrada. Digite o PIN novamente para reconectar.', true); });
    });
  };

  $('bFile').onclick = () => $('file').click();
  $('file').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (f.size > 60 * 1024 * 1024) return msg(sst, 'Arquivo acima de 60 MB. Envie um menor.', true);
    msg(sst, 'Preparando ' + f.name + '…');
    try { await enviarTransferencia('file', { name: f.name, type: f.type }, [f]); msg(sst, 'Enviado: ' + f.name); }
    catch (err) { ocultarProgresso(); msg(sst, err.message || 'Falha ao enviar o arquivo.', true); }
  };

  $('bDeck').onclick = () => $('deckIn').click();
  $('deckIn').onchange = async e => {
    const fs = [...e.target.files]; e.target.value = '';
    if (!fs.length) return;
    if (fs.reduce((s, f) => s + f.size, 0) > 60 * 1024 * 1024) return msg(sst, 'Slides acima de 60 MB no total.', true);
    msg(sst, 'Preparando slides…');
    const pdf = fs.find(f => f.type === 'application/pdf');
    try {
      if (pdf) await enviarTransferencia('deck-pdf', {}, [pdf]);
      else {
        const imgs = fs.filter(f => f.type.startsWith('image/')).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        if (!imgs.length) return msg(sst, 'Escolha um PDF ou imagens.', true);
        await enviarTransferencia('deck-images', {}, imgs);
      }
      msg(sst, 'Slides enviados. Use os botões para trocar de slide.');
    } catch (err) { ocultarProgresso(); msg(sst, err.message || 'Falha ao enviar os slides.', true); }
  };
  $('bPrev').onclick = () => enviarMsg({ t: 'nav', cmd: 'prev' });
  $('bNext').onclick = () => enviarMsg({ t: 'nav', cmd: 'next' });
  $('bGo').onclick = () => { const n = parseInt($('goN').value, 10); if (n > 0) enviarMsg({ t: 'nav', cmd: 'goto', n }); };

  $('bTxt').onclick = () => {
    const x = $('txt').value.trim(); if (!x) return;
    if (enviarMsg({ t: 'text', text: x })){ $('txt').value = ''; msg(sst, 'Mensagem enviada.'); }
  };
  $('bLnk').onclick = () => {
    const u = $('lnk').value.trim();
    try { const parsed = new URL(u); if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname || u.length > 2048) throw 0; } catch (e) { return msg(sst, 'Informe um endereço HTTP ou HTTPS válido.', true); }
    if (enviarMsg({ t: 'link', url: u })){ $('lnk').value = ''; msg(sst, 'Link enviado.'); }
  };

  async function transmitir(tipo){
    parar();
    try {
      localStream = tipo === 'tela'
        ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        : await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false });
    } catch (err) { return msg(sst, 'Permissão negada ou recurso indisponível.', true); }
    if (!peer || peer.destroyed) { parar(); return msg(sst, 'Conexão com o projetor perdida. Reconecte antes de transmitir.', true); }
    call = peer.call(PREFIX + pin, localStream, { config: ICE });
    localStream.getVideoTracks()[0].onended = parar;
    call.on('error', () => msg(sst, 'Falha ao iniciar a transmissão de vídeo.', true));
    $('bStop').hidden = false;
    msg(sst, tipo === 'tela' ? 'Transmitindo a tela.' : 'Transmitindo a câmera.');
  }
  function parar(){
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    if (call) call.close();
    localStream = call = null; $('bStop').hidden = true;
  }
  $('bCam').onclick = () => transmitir('camera');
  $('bTela').onclick = () => transmitir('tela');
  $('bFlip').onclick = () => { facing = facing === 'environment' ? 'user' : 'environment'; if (localStream) transmitir('camera'); };
  $('bStop').onclick = () => { parar(); msg(sst, 'Transmissão parada.'); };
  $('bSair').onclick = () => { parar(); if (conn) conn.close(); if (peer) peer.destroy(); location.hash = '#enviar'; location.reload(); };

  const m = location.hash.match(/^#enviar-(\d{6})$/);
  if (m){ $('pinIn').value = m[1]; $('nome').focus(); }
}
