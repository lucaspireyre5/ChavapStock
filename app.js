/* Cha'Vap Stock V2 — Cloud Supabase (authentification, RLS, sauvegardes JSON). */
(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const eur = new Intl.NumberFormat('fr-FR', {style: 'currency', currency: 'EUR'});
  const integer = new Intl.NumberFormat('fr-FR');
  const dateTime = new Intl.DateTimeFormat('fr-FR', {dateStyle: 'medium', timeStyle: 'short'});
  const todayFormat = new Intl.DateTimeFormat('fr-FR', {day: 'numeric', month: 'long', year: 'numeric'});
  const dateShort = new Intl.DateTimeFormat('fr-FR', {weekday: 'long', day: 'numeric', month: 'long'});

  const state = {
    cloud: null, products: [], movements: [], tab: 'dashboard',
    search: '', filter: 'all', category: 'all', sort: 'recent',
    editingId: null, editingOriginal: null, editingImage: '', movementId: null, busy: false, toastTimer: null, refreshTimer: null
  };

  function uid() {
    if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `stock-${Date.now()}-${Math.random().toString(36).slice(2, 13)}`;
  }
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
  }
  function money(n) { return eur.format(Number.isFinite(Number(n)) ? Number(n) : 0); }
  function num(n) { return Number(String(n ?? 0).replace(',', '.')); }
  function rounded(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function safeDate(s) { const d = new Date(s); return isNaN(d.getTime()) ? '—' : dateTime.format(d); }
  function trimmed(s, max = 130) { return String(s ?? '').trim().slice(0, max); }
  function validImage(s) {
    return typeof s === 'string' && s.length <= 1800000 && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : '';
  }
  function status(product) {
    const qty = product.quantity;
    return qty === 0 ? 'out' : qty <= product.minQuantity ? 'low' : 'ok';
  }
  function statusLabel(kind) { return kind === 'out' ? 'Rupture' : kind === 'low' ? 'Stock faible' : 'Disponible'; }
  function derived(product) {
    const rate = Number(product.vatRate) || 0;
    const saleHT = product.saleTTC / (1 + rate / 100);
    const vat = product.saleTTC - saleHT;
    const profit = saleHT - product.purchaseHT - product.extraCostHT;
    const margin = saleHT > 0 ? profit / saleHT * 100 : 0;
    return {saleHT, vat, profit, margin};
  }
  function thumb(product) {
    return `<span class="thumb">${product.image ? `<img alt="" loading="lazy" src="${esc(product.image)}">` : '▧'}</span>`;
  }
  function toast(message, isError = false) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { el.hidden = true; }, 4300);
  }

  async function refresh() {
    const data = await state.cloud.refresh();
    state.products = data.products;
    state.movements = data.movements;
    state.movements.sort((a,b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    render();
    $('#sync-status').textContent = 'Synchronisé avec Supabase';
    $('.status-dot').classList.add('is-ok');
  }
  function scheduleRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(async () => {
      if (state.busy || !state.cloud?.user) return scheduleRefresh();
      try {await refresh();} catch(e) {cloudError(e);}
    }, 850);
  }
  function cloudError(error) {
    console.error(error);
    $('#sync-status').textContent = 'Connexion à vérifier';
    $('.status-dot').classList.add('is-error');
    toast('Synchronisation : ' + (error?.message || 'erreur réseau'), true);
  }

  async function runMutation(job, successMessage) {
    if (state.busy) return false;
    state.busy = true;
    try {
      await job();
      await refresh();
      if (successMessage) toast(successMessage);
      return true;
    } catch (error) {
      console.error(error);
      toast('Enregistrement impossible : ' + (error?.message || 'erreur inconnue'), true);
      return false;
    } finally { state.busy = false; }
  }

  function navigate(tab) {
    if (!['dashboard','products','history','backup'].includes(tab)) return;
    state.tab = tab;
    $$('.view').forEach(view => view.classList.toggle('active', view.id === `view-${tab}`));
    $$('.nav-link').forEach(btn => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('active', active);
      if (active) btn.setAttribute('aria-current','page'); else btn.removeAttribute('aria-current');
    });
    window.scrollTo({top: 0, behavior: 'instant'});
  }
  function empty(message, detail) {
    return `<div class="empty-state"><span class="empty-icon">▧</span><strong>${esc(message)}</strong>${esc(detail || '')}</div>`;
  }
  function render() {
    $('#nav-product-count').textContent = integer.format(state.products.length);
    renderDashboard(); renderProducts(); renderHistory();
  }
  function renderDashboard() {
    const stockUnits = state.products.reduce((acc,p) => acc + p.quantity, 0);
    const valuation = state.products.reduce((acc,p) => acc + p.purchaseHT * p.quantity, 0);
    const profit = state.products.reduce((acc,p) => acc + derived(p).profit * p.quantity, 0);
    $('#stat-products').textContent = integer.format(state.products.length);
    $('#stat-units').textContent = integer.format(stockUnits);
    $('#stat-cost').textContent = money(valuation);
    $('#stat-profit').textContent = money(profit);
    $('#stat-profit').classList.toggle('danger-text', profit < 0);
    const alerts = state.products.filter(p => status(p) !== 'ok').sort((a,b) => a.quantity - b.quantity);
    $('#alerts-count').textContent = String(alerts.length);
    $('#alerts-list').innerHTML = alerts.length ? alerts.slice(0,5).map(p => {
      const kind = status(p);
      return `<div class="stock-alert">${thumb(p)}<div class="alert-main"><strong>${esc(p.name)}</strong><small>${esc(p.sku || 'Sans référence')} · Seuil : ${integer.format(p.minQuantity)}</small></div><span class="qty-badge ${kind}">${integer.format(p.quantity)} en stock</span></div>`;
    }).join('') : empty('Aucune alerte', 'Tous les niveaux de stock sont satisfaisants.');
    const categories = new Map();
    for (const p of state.products) categories.set(p.category || 'Non classé', (categories.get(p.category || 'Non classé') || 0) + p.quantity);
    const rows = [...categories.entries()].sort((a,b) => b[1]-a[1]).slice(0,7);
    const max = Math.max(...rows.map(r => r[1]), 1);
    $('#category-chart').innerHTML = rows.length ? rows.map(([name,count]) => `<div><div class="category-label"><span>${esc(name)}</span><span>${integer.format(count)} unité(s)</span></div><div class="bar-track"><div class="bar-value" style="width:${Math.max(count > 0 ? 2 : 0, count / max * 100)}%"></div></div></div>`).join('') : empty('Pas encore de catégories', 'Ajoutez un premier article pour commencer.');
    $('#recent-movements').innerHTML = state.movements.length ? state.movements.slice(0,5).map(m => `<div class="movement-row"><span class="movement-symbol ${m.delta < 0 ? 'negative' : ''}">${m.delta < 0 ? '↘' : '↗'}</span><div class="movement-desc"><strong>${esc(m.productName)}</strong><small>${esc(m.reason)} · ${esc(safeDate(m.at))}</small></div><span class="movement-amount ${m.delta < 0 ? 'negative' : ''}">${m.delta > 0 ? '+' : ''}${integer.format(m.delta)}</span></div>`).join('') : empty('Aucun mouvement enregistré', 'Les entrées et sorties apparaîtront ici.');
  }
  function filteredProducts() {
    let list = state.products.filter(p => {
      const query = state.search.toLocaleLowerCase('fr');
      const haystack = [p.name,p.sku,p.category,p.supplier,p.barcode,p.location].join(' ').toLocaleLowerCase('fr');
      return (!query || haystack.includes(query)) && (state.filter === 'all' || status(p) === state.filter) && (state.category === 'all' || (p.category || 'Non classé') === state.category);
    });
    switch (state.sort) {
      case 'name': list.sort((a,b) => a.name.localeCompare(b.name,'fr')); break;
      case 'quantity': list.sort((a,b) => a.quantity - b.quantity); break;
      case 'profit': list.sort((a,b) => derived(b).profit - derived(a).profit); break;
      default: list.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    }
    return list;
  }
  function renderProducts() {
    const options = [...new Set(state.products.map(p => p.category || 'Non classé'))].sort((a,b) => a.localeCompare(b,'fr'));
    const filter = $('#category-filter');
    filter.innerHTML = '<option value="all">Toutes les catégories</option>' + options.map(name => `<option value="${esc(name)}">${esc(name)}</option>`).join('');
    if (!options.includes(state.category)) state.category = 'all';
    filter.value = state.category;
    const products = filteredProducts();
    $('#product-results').textContent = `${integer.format(products.length)} article${products.length > 1 ? 's' : ''} affiché${products.length > 1 ? 's' : ''}`;
    $('#products-body').innerHTML = products.length ? products.map(p => {
      const calc = derived(p), kind = status(p);
      const profitClass = calc.profit < 0 ? 'negative' : '';
      return `<tr><td><div class="product-identity">${thumb(p)}<div class="product-info"><strong title="${esc(p.name)}">${esc(p.name)}</strong><small>${esc(p.sku || 'Sans référence')}</small></div></div></td><td class="cell-secondary">${esc(p.category || 'Non classé')}</td><td><div class="stock-cell"><span class="stock-number">${integer.format(p.quantity)}</span><span class="qty-badge ${kind}">${statusLabel(kind)}</span></div></td><td>${money(p.purchaseHT)}</td><td><strong>${money(p.saleTTC)}</strong></td><td class="cell-secondary">${money(calc.vat)} <small>(${p.vatRate} %)</small></td><td><span class="cell-profit ${profitClass}">${money(calc.profit)}</span> <small class="muted">(${Math.round(calc.margin)} %)</small></td><td><div class="action-group"><button type="button" class="mini-action" data-action="stock" data-id="${esc(p.id)}" title="Entrée ou sortie de stock">± Stock</button><button type="button" class="mini-action" data-action="edit" data-id="${esc(p.id)}">Modifier</button><button type="button" class="mini-action danger" data-action="delete" data-id="${esc(p.id)}" title="Supprimer cet article">×</button></div></td></tr>`;
    }).join('') : `<tr><td colspan="8">${empty(state.products.length ? 'Aucun article ne correspond aux filtres.' : 'Votre catalogue est vide', state.products.length ? 'Essayez une autre recherche.' : 'Cliquez sur « Nouvel article » pour commencer.')}</td></tr>`;
  }
  function renderHistory() {
    $('#history-results').textContent = `${integer.format(state.movements.length)} mouvement${state.movements.length > 1 ? 's' : ''}`;
    $('#history-body').innerHTML = state.movements.length ? state.movements.map(m => `<tr><td class="cell-secondary">${esc(safeDate(m.at))}</td><td><strong>${esc(m.productName)}</strong></td><td>${esc(m.reason)}</td><td class="${m.delta < 0 ? 'danger-text' : 'cell-profit'}">${m.delta > 0 ? '+' : ''}${integer.format(m.delta)}</td><td>${integer.format(m.before)} → ${integer.format(m.after)}</td><td class="cell-secondary">${esc(m.note || '—')}</td></tr>`).join('') : `<tr><td colspan="6">${empty('Aucun mouvement', 'Les modifications de quantité sont consignées ici.')}</td></tr>`;
  }

  function showModal(id) { $(id).hidden = false; document.body.style.overflow = 'hidden'; }
  function hideModal(id) { $(id).hidden = true; if ($$('.modal:not([hidden])').length === 0) document.body.style.overflow = ''; }
  function displayDraftImage() {
    $('#image-preview').innerHTML = state.editingImage
      ? `<img alt="Aperçu de la photo du produit" src="${esc(state.editingImage)}">`
      : '<span class="image-symbol">▧</span><strong>Ajouter une photo</strong><small>JPG, PNG, WEBP · 8 Mo max</small>';
    $('#remove-image').hidden = !state.editingImage;
  }
  function newProduct(id = null) {
    const p = id ? state.products.find(item => item.id === id) : null;
    if (id && !p) return toast('Article introuvable.', true);
    state.editingId = p?.id || null;
    // Conserver la version exacte à l'ouverture du formulaire pour détecter
    // une modification concurrente, même si la liste se rafraîchit en fond.
    state.editingOriginal = p ? {...p} : null;
    state.editingImage = p?.image || '';
    const form = $('#product-form');
    form.reset();
    for (const key of ['name','sku','category','supplier','barcode','purchaseHT','saleTTC','vatRate','extraCostHT','quantity','minQuantity','location','notes']) {
      if (p) form.elements.namedItem(key).value = p[key] ?? '';
    }
    $('#product-image').value = '';
    $('#product-modal-title').textContent = p ? 'Modifier un article' : 'Nouvel article';
    $('#save-product').textContent = p ? 'Enregistrer les modifications' : 'Enregistrer l’article';
    displayDraftImage(); updatePricePreview(); showModal('#product-modal');
    $('#field-name').focus();
  }
  function updatePricePreview() {
    const form = $('#product-form');
    const p = {
      purchaseHT: Math.max(0, num(form.elements.namedItem('purchaseHT').value) || 0),
      saleTTC: Math.max(0, num(form.elements.namedItem('saleTTC').value) || 0),
      vatRate: num(form.elements.namedItem('vatRate').value) || 0,
      extraCostHT: Math.max(0, num(form.elements.namedItem('extraCostHT').value) || 0)
    };
    const result = derived(p);
    $('#preview-sale-ht').textContent = money(result.saleHT);
    $('#preview-vat').textContent = money(result.vat);
    $('#preview-profit').textContent = money(result.profit);
    $('#preview-profit').classList.toggle('negative', result.profit < 0);
    $('#preview-margin').textContent = `${new Intl.NumberFormat('fr-FR',{maximumFractionDigits:1}).format(result.margin)} %`;
    $('#preview-margin').classList.toggle('negative', result.margin < 0);
  }
  function numericField(form, key, max = 10000000) {
    const value = num(form.elements.namedItem(key).value);
    if (!Number.isFinite(value) || value < 0 || value > max) throw new Error(`Valeur incorrecte : ${key}.`);
    return value;
  }
  function integerField(form, key) {
    const value = numericField(form, key, 100000000);
    if (!Number.isSafeInteger(value)) throw new Error(`La quantité « ${key} » doit être un entier.`);
    return value;
  }
  function makeMovement(product, delta, before, reason, note = '') {
    return {id: uid(), productId: product.id, productName: product.name, delta, before, after: before + delta, reason, note: trimmed(note, 500), at: new Date().toISOString()};
  }
  async function saveProduct(event) {
    event.preventDefault();
    const form = $('#product-form');
    if (!form.reportValidity()) return;
    const original = state.editingOriginal;
    try {
      const name = trimmed(form.elements.namedItem('name').value);
      if (!name) throw new Error('Le nom du produit est obligatoire.');
      const quantity = integerField(form, 'quantity');
      const sku = trimmed(form.elements.namedItem('sku').value, 80);
      if (sku && state.products.some(p => p.id !== original?.id && p.sku?.toLocaleLowerCase('fr') === sku.toLocaleLowerCase('fr'))) {
        throw new Error('Cette référence SKU existe déjà dans le catalogue.');
      }
      const product = {
        id: original?.id || uid(), name, sku,
        category: trimmed(form.elements.namedItem('category').value, 80),
        supplier: trimmed(form.elements.namedItem('supplier').value, 100),
        barcode: trimmed(form.elements.namedItem('barcode').value, 100),
        location: trimmed(form.elements.namedItem('location').value, 100),
        notes: trimmed(form.elements.namedItem('notes').value, 1200),
        purchaseHT: rounded(numericField(form, 'purchaseHT')),
        saleTTC: rounded(numericField(form, 'saleTTC')),
        vatRate: numericField(form, 'vatRate', 100),
        extraCostHT: rounded(numericField(form, 'extraCostHT')),
        quantity, minQuantity: integerField(form, 'minQuantity'),
        image: state.editingImage, createdAt: original?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString()
      };
      const ok = await runMutation(() => state.cloud.saveProduct(product, original),
        original ? 'Article enregistré sur tous les appareils.' : 'Nouvel article partagé dans Supabase.');
      if (ok) hideModal('#product-modal');
    } catch (error) { toast(error.message, true); }
  }
  function openMovement(id) {
    const p = state.products.find(p => p.id === id);
    if (!p) return toast('Article introuvable.', true);
    state.movementId = id;
    $('#movement-form').reset();
    $('#movement-product-name').textContent = p.name;
    $('#current-quantity').textContent = integer.format(p.quantity);
    updateMovementHint(); showModal('#movement-modal');
  }
  function updateMovementHint() {
    const form = $('#movement-form');
    const type = form.elements.namedItem('type').value;
    const qty = Math.max(0, Math.trunc(num(form.elements.namedItem('amount').value) || 0));
    const p = state.products.find(p => p.id === state.movementId);
    if (!p) return;
    const adjustment = type === 'adjustment';
    const minus = type === 'sale' || type === 'loss';
    $('#movement-qty-label').textContent = adjustment ? 'Nouveau stock total souhaité' : 'Nombre d’unités';
    form.elements.namedItem('amount').min = adjustment ? '0' : '1';
    let final = adjustment ? qty : p.quantity + (minus ? -qty : qty);
    $('#movement-hint').textContent = `Stock après opération : ${integer.format(final)} unité(s)${final < 0 ? ' — impossible : stock négatif' : ''}.`;
    $('#movement-hint').classList.toggle('danger-text', final < 0);
  }
  async function saveMovement(event) {
    event.preventDefault();
    const form = $('#movement-form');
    if (!form.reportValidity()) return;
    const p = state.products.find(p => p.id === state.movementId);
    if (!p) return toast('Article introuvable.', true);
    const type = form.elements.namedItem('type').value;
    const qty = num(form.elements.namedItem('amount').value);
    if (!Number.isSafeInteger(qty) || qty < (type === 'adjustment' ? 0 : 1) || qty > 100000000) return toast('Quantité invalide.', true);
    const ok = await runMutation(() => state.cloud.stock(p.id, type, qty,
      form.elements.namedItem('note').value), 'Stock et historique synchronisés.');
    if (ok) hideModal('#movement-modal');
  }
  async function deleteProduct(id) {
    const p = state.products.find(p => p.id === id);
    if (!p || !confirm(`Supprimer « ${p.name} » du catalogue ?\n\nSon historique de mouvements sera conservé.`)) return;
    await runMutation(() => state.cloud.deleteProduct(p), 'Article supprimé du stock partagé.');
  }

  function download(content, mime, filename) {
    const blob = new Blob([content], {type: mime});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function timestamp() { return new Date().toISOString().slice(0,10); }
  async function exportJSON() {
    if (state.busy || !state.cloud?.user) return;
    state.busy=true;
    const buttons = ['#export-json','#export-header'].map(sel=>$(sel));
    const labels=buttons.map(btn=>btn.innerHTML);
    buttons.forEach(btn=>btn.disabled=true);
    try {
      // Charger une image à la fois pour une sauvegarde complète, sans URL temporaire.
      const data=await state.cloud.refresh();
      const payload=await state.cloud.backup(data.products,data.movements,(done,total)=>{
        $('#export-json').textContent=`Photos : ${done} / ${total}`;
      });
      const out=JSON.stringify(payload);
      download(out,'application/json;charset=utf-8',`chavap-sauvegarde-complete-${timestamp()}.json`);
      toast('Sauvegarde complète téléchargée, avec toutes les photos.');
    } catch(e) {console.error(e);toast('Sauvegarde interrompue : '+e.message, true);}
    finally {
      buttons.forEach((btn,i)=>{btn.disabled=false;btn.innerHTML=labels[i];});
      state.busy=false;
    }
  }
  function csvCell(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
  function csv(rows) { return '\uFEFF' + rows.map(row => row.map(csvCell).join(';')).join('\r\n'); }
  function exportProductsCSV() {
    const rows = [['Produit','Référence SKU','Catégorie','Fournisseur','Code-barres','Emplacement','Quantité','Seuil d’alerte','Prix achat HT (€)','Prix vente TTC (€)','Taux TVA (%)','TVA vente unité (€)','Prix vente HT (€)','Frais HT unité (€)','Bénéfice brut unité HT (€)','Marge sur vente HT (%)','Valeur stock achat HT (€)','Bénéfice brut potentiel stock HT (€)','Notes']];
    for (const p of state.products) {
      const calc = derived(p);
      const decimal = n => rounded(n).toFixed(2).replace('.', ',');
      rows.push([p.name,p.sku,p.category,p.supplier,p.barcode,p.location,p.quantity,p.minQuantity,decimal(p.purchaseHT),decimal(p.saleTTC),String(p.vatRate).replace('.',','),decimal(calc.vat),decimal(calc.saleHT),decimal(p.extraCostHT),decimal(calc.profit),decimal(calc.margin),decimal(p.purchaseHT*p.quantity),decimal(calc.profit*p.quantity),p.notes]);
    }
    download(csv(rows),'text/csv;charset=utf-8',`chavap-articles-${timestamp()}.csv`);
    toast('Catalogue CSV exporté.');
  }
  function exportHistoryCSV() {
    const rows = [['Date','Article','Motif','Quantité (variation)','Stock avant','Stock après','Commentaire']];
    state.movements.forEach(m => rows.push([safeDate(m.at),m.productName,m.reason,m.delta,m.before,m.after,m.note]));
    download(csv(rows),'text/csv;charset=utf-8',`chavap-mouvements-${timestamp()}.csv`);
    toast('Historique CSV exporté.');
  }
  function normalizeProduct(p) {
    if (!p || typeof p !== 'object' || !trimmed(p.name)) throw new Error('Une fiche article est invalide dans cette sauvegarde.');
    const monetary = (value, limit = 10000000) => {
      const v = Number(value);
      if (!Number.isFinite(v) || v < 0 || v > limit) throw new Error('Montant incorrect dans la sauvegarde.');
      return rounded(v);
    };
    const whole = value => {const v = Number(value); if (!Number.isSafeInteger(v) || v < 0 || v > 100000000) throw new Error('Quantité incorrecte dans la sauvegarde.'); return v;};
    const id = String(p.id ?? '');
    if (!/^[\w-]{1,120}$/.test(id)) throw new Error('Identifiant de produit invalide.');
    if (p.image && !validImage(p.image)) throw new Error('Image de produit invalide ou trop volumineuse.');
    return {id,name:trimmed(p.name),sku:trimmed(p.sku,80),category:trimmed(p.category,80),supplier:trimmed(p.supplier,100),barcode:trimmed(p.barcode,100),location:trimmed(p.location,100),notes:trimmed(p.notes,1200),purchaseHT:monetary(p.purchaseHT),saleTTC:monetary(p.saleTTC),vatRate:monetary(p.vatRate,100),extraCostHT:monetary(p.extraCostHT),quantity:whole(p.quantity),minQuantity:whole(p.minQuantity),image:p.image || '',createdAt:trimmed(p.createdAt,40) || new Date().toISOString(),updatedAt:trimmed(p.updatedAt,40) || new Date().toISOString()};
  }
  function normalizeMovement(m) {
    if (!m || typeof m !== 'object' || !/^[\w-]{1,120}$/.test(String(m.id ?? ''))) throw new Error('Mouvement invalide dans la sauvegarde.');
    const delta = Number(m.delta), before = Number(m.before), after = Number(m.after);
    if (![delta,before,after].every(n => Number.isSafeInteger(n) && Math.abs(n) <= 100000000) || before < 0 || after < 0 || before + delta !== after) throw new Error('Historique de stock incohérent dans la sauvegarde.');
    return {id:m.id,productId:trimmed(m.productId,120),productName:trimmed(m.productName),reason:trimmed(m.reason,100),note:trimmed(m.note,500),delta,before,after,at:trimmed(m.at,40) || new Date().toISOString()};
  }
  async function importBackup(event) {
    const file=event.target.files?.[0];
    event.target.value='';
    if (!file || state.busy) return;
    if (file.size > window.ChavapCloud.MAX_BACKUP_SIZE) {
      return toast('Fichier trop lourd : 250 Mo maximum (limite du navigateur).',true);
    }
    try {
      const raw=JSON.parse(await file.text());
      if (raw?.format !== 'chavap-stock' || ![1,2].includes(raw.version) ||
          !Array.isArray(raw.products) || !Array.isArray(raw.movements)) {
        throw new Error('Fichier non reconnu : sauvegarde JSON Cha’Vap V1/V2 requise.');
      }
      if (raw.products.length>30000 || raw.movements.length>150000) throw new Error('Sauvegarde trop volumineuse.');
      const products=raw.products.map(normalizeProduct);
      const movements=raw.movements.map(normalizeMovement);
      if (new Set(products.map(p=>p.id)).size !== products.length ||
          new Set(movements.map(m=>m.id)).size !== movements.length) {
        throw new Error('Identifiants en double dans la sauvegarde.');
      }
      const skus=products.map(p=>p.sku?.trim().toLowerCase()).filter(Boolean);
      if (new Set(skus).size !== skus.length) throw new Error('Deux articles ont le même SKU dans la sauvegarde.');
      if (!confirm(`Restaurer ${products.length} article(s), ${movements.length} mouvement(s) et leurs photos ?\n\nATTENTION : cela EFFACERA et REMPLACERA l'inventaire Supabase partagé sur TOUS les appareils.\n\nSauvegardez d'abord la base actuelle !`)) return;
      if (prompt('Pour confirmer le remplacement de la base partagée, tapez exactement RESTAURER :') !== 'RESTAURER') return;
      state.busy=true;
      const button=$('.upload-button');
      const before=button.firstChild.textContent;
      try {
        await state.cloud.restore(products,movements,(done,total)=>{
          button.firstChild.textContent=`Restauration ${done}/${total}…`;
        });
        await refresh();
        navigate('dashboard');
        toast('Base partagée restaurée sur Supabase.');
      } catch(e) {
        cloudError(e);
        toast('Restauration interrompue : '+e.message+' — actualisez la page pour vérifier l’état réel avant toute nouvelle tentative.',true);
      } finally {
        button.firstChild.textContent=before;
        state.busy=false;
      }
    } catch(error) {console.error(error);toast('Fichier invalide : '+error.message,true);}
  }
  async function resetAll() {
    if (!confirm('Vider les articles ET l’historique sur Supabase, pour TOUS les appareils ? Cette opération est irréversible.')) return;
    if (prompt('Pour tout effacer dans Supabase, écrivez EFFACER :') !== 'EFFACER') return;
    const ok=await runMutation(()=>state.cloud.reset(),'Base Supabase vidée.');
    if (ok) navigate('dashboard');
  }
  function processImage(file) {
    return new Promise((resolve, reject) => {
      if (!file || !['image/jpeg','image/png','image/webp','image/gif'].includes(file.type)) return reject(new Error('Choisissez un fichier image JPG, PNG, WEBP ou GIF.'));
      if (file.size > 8 * 1024 * 1024) return reject(new Error('Cette photo dépasse 8 Mo.'));
      const img = new Image();
      const blobUrl = URL.createObjectURL(file);
      img.onload = () => {
        try {
          const max = 860;
          const ratio = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Impossible de traiter cette photo.');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const result = canvas.toDataURL('image/webp', 0.77);
          URL.revokeObjectURL(blobUrl);
          if (!validImage(result)) throw new Error('Photo trop volumineuse après compression.');
          resolve(result);
        } catch (err) { URL.revokeObjectURL(blobUrl); reject(err); }
      };
      img.onerror = () => {URL.revokeObjectURL(blobUrl); reject(new Error('Photo illisible.'));};
      img.src = blobUrl;
    });
  }
  async function uploadImage(file) {
    if (!file) return;
    try { state.editingImage = await processImage(file); displayDraftImage(); toast('Photo ajoutée à la fiche.'); }
    catch (error) { toast(error.message, true); }
  }
  function bindEvents() {
    $$('.nav-link').forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.tab)));
    $$('[data-open-tab]').forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.openTab)));
    $('.brand').addEventListener('click', event => {event.preventDefault(); navigate('dashboard');});
    ['#new-product-top','#hero-add','#new-product-page'].forEach(sel => $(sel).addEventListener('click', () => newProduct()));
    $$('.close-modal').forEach(btn => btn.addEventListener('click', () => hideModal('#product-modal')));
    $$('.close-movement').forEach(btn => btn.addEventListener('click', () => hideModal('#movement-modal')));
    $$('.modal').forEach(modal => modal.addEventListener('mousedown', e => { if (e.target === modal) hideModal('#' + modal.id); }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal:not([hidden])').forEach(modal => hideModal('#'+modal.id)); });
    $('#product-form').addEventListener('submit', saveProduct);
    $('#movement-form').addEventListener('submit', saveMovement);
    ['purchaseHT','saleTTC','vatRate','extraCostHT'].forEach(name => $('#product-form').elements.namedItem(name).addEventListener('input', updatePricePreview));
    $('#product-image').addEventListener('change', e => {uploadImage(e.target.files?.[0]); e.target.value = '';});
    $('#remove-image').addEventListener('click', () => {state.editingImage = ''; displayDraftImage();});
    const drop = $('#image-drop');
    ['dragenter','dragover'].forEach(eventName => drop.addEventListener(eventName, e => {e.preventDefault(); drop.classList.add('dragging');}));
    ['dragleave','drop'].forEach(eventName => drop.addEventListener(eventName, e => {e.preventDefault(); drop.classList.remove('dragging');}));
    drop.addEventListener('drop', e => uploadImage(e.dataTransfer?.files?.[0]));
    ['type','amount'].forEach(name => $('#movement-form').elements.namedItem(name).addEventListener('input', updateMovementHint));
    $('#search-input').addEventListener('input', e => {state.search = e.target.value.trim(); renderProducts();});
    $('#category-filter').addEventListener('change', e => {state.category = e.target.value; renderProducts();});
    $('#stock-filter').addEventListener('change', e => {state.filter = e.target.value; renderProducts();});
    $('#sort-select').addEventListener('change', e => {state.sort = e.target.value; renderProducts();});
    $('#products-body').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      switch (btn.dataset.action) {case 'edit': newProduct(btn.dataset.id);break;case 'stock':openMovement(btn.dataset.id);break;case 'delete':void deleteProduct(btn.dataset.id);break;}
    });
    ['#export-header','#export-json'].forEach(sel => $(sel).addEventListener('click', exportJSON));
    $('#export-csv').addEventListener('click', exportProductsCSV);
    $('#history-export').addEventListener('click', exportHistoryCSV);
    $('#import-file').addEventListener('change', importBackup);
    $('#reset-all').addEventListener('click', resetAll);
  }
  function loginError(message) {
    const element=$('#login-error');
    element.textContent=message;
    element.hidden=false;
  }
  async function revealApp() {
    if (!await state.cloud.isMember()) {
      await state.cloud.logout();
      throw new Error('Compte non autorisé. Ajoutez cet utilisateur à chavap_members dans Supabase.');
    }
    await refresh();
    $('#app-shell').hidden=false;
    $('#auth-overlay').hidden=true;
    $('#login-error').hidden=true;
    state.cloud.startUpdates(scheduleRefresh);
  }
  async function doLogin(e) {
    e.preventDefault();
    if (!state.cloud) return;
    const btn=$('#login-submit');
    btn.disabled=true;
    btn.textContent='Connexion…';
    $('#login-error').hidden=true;
    try {
      await state.cloud.login($('#login-email').value.trim(),$('#login-password').value);
      await revealApp();
      $('#login-password').value='';
    } catch(err) {console.error(err);loginError(err.message);}
    finally {btn.disabled=false;btn.textContent='Se connecter';}
  }
  async function doLogout() {
    if (state.busy) return;
    try {await state.cloud.logout();} catch(e) {console.error(e);}
    clearTimeout(state.refreshTimer);
    state.products=[];state.movements=[];
    $('#app-shell').hidden=true;
    $('#auth-overlay').hidden=false;
    $('#login-password').value='';
  }
  async function start() {
    $('#today').textContent=dateShort.format(new Date());
    $('#dashboard-date').textContent=todayFormat.format(new Date());
    bindEvents();
    $('#login-form').addEventListener('submit',doLogin);
    $('#logout').addEventListener('click',doLogout);
    $('#change-password').addEventListener('click',()=>{
      $('#password-form').reset();
      $('#password-error').hidden=true;
      $('#password-modal').hidden=false;
      $('#password-current').focus();
    });
    document.querySelectorAll('.close-password').forEach(button=>button.addEventListener('click',()=>{$('#password-modal').hidden=true;$('#password-form').reset();}));
    $('#password-form').addEventListener('submit',async e=>{
      e.preventDefault();
      const current=$('#password-current').value;
      const next=$('#password-new').value;
      const confirm=$('#password-confirm').value;
      const error=$('#password-error');error.hidden=true;
      if(next.length<12 || next!==confirm || next===current){
        error.textContent='Choisissez un nouveau mot de passe d’au moins 12 caractères, différent de l’ancien, et confirmez-le.';
        error.hidden=false;return;
      }
      const btn=$('#password-save');btn.disabled=true;
      try{
        await state.cloud.changePassword(current,next);
        $('#password-modal').hidden=true;$('#password-form').reset();
        toast('Mot de passe modifié.');
      }catch(err){error.textContent=err.message||'Impossible de changer le mot de passe.';error.hidden=false;}
      finally{btn.disabled=false;}
    });
    $('#reload-cloud').addEventListener('click',()=>{
      if (!state.busy) refresh().then(()=>toast('Données actualisées.')).catch(cloudError);
    });
    document.addEventListener('visibilitychange',()=>{if (!document.hidden && state.cloud?.user) scheduleRefresh();});
    // Synchronisation de secours si Realtime n'est pas actif sur le projet.
    setInterval(()=>{if (!document.hidden && state.cloud?.user && !state.busy) scheduleRefresh();},45000);
    try {
      state.cloud=window.ChavapCloud.create(window.CHAVAP_SUPABASE);
      const user=await state.cloud.session();
      if (user) await revealApp();
    } catch(err) {
      console.error('Initialisation Supabase :',err);
      if (err.message.includes('Configuration') || err.message.includes('bibliothèque')) $('#login-submit').disabled=true;
      loginError(err.message);
    }
  }
  start();
})();
