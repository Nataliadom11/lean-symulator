let currentRole = "";
let currentStation = sessionStorage.getItem("leanStation") || "";
let orders = [];
let warehouseSlots = [];
let orderItems = [];
let containerItems = [];
let printJobs = [];
let simulationState = null;
let courierLoopStarted = false;
let printerLoopStarted = false;
let cart = [];
let orderDraft = {
  customerName: "",
  customerEmail: "",
  customerPhone: "",
  customerAddress: "",
  delivery: "Paczkomat",
  badEmail: false
};
let returnMode = null;
let channelsStarted = false;
let currentMinute = 480;

function login() {
  currentRole = document.getElementById("roleSelect").value;
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("app").style.display = "block";
  initializeNetworkApp();
}

async function initializeNetworkApp() {
  showLoading("Łączenie ze wspólną bazą danych...");
  const ok = await loadAllData();
  if (!ok) return;
  subscribeRealtime();
  renderCurrentRole();
}

function showLoading(message) {
  document.getElementById("roleTitle").innerText = "Symulator sieciowy";
  document.getElementById("content").innerHTML = `<div class="card">${escapeHtml(message)}</div>`;
}

async function loadAllData() {
  try {
    const [ordersRes, warehouseRes, itemsRes, containerRes, printRes, simRes] = await Promise.all([
      supabaseClient.from("orders").select("*").order("order_number", { ascending: true }),
      supabaseClient.from("warehouse_slots").select("*").order("id", { ascending: true }),
      supabaseClient.from("order_items").select("*").order("id", { ascending: true }),
      supabaseClient.from("container_items").select("*").order("id", { ascending: true }),
      supabaseClient.from("print_jobs").select("*").order("created_at", { ascending: true }),
      supabaseClient.from("simulation_state").select("*").eq("id", 1).single()
    ]);
    for (const result of [ordersRes, warehouseRes, itemsRes, containerRes, printRes, simRes]) {
      if (result.error) throw result.error;
    }
    orders = ordersRes.data || [];
    warehouseSlots = warehouseRes.data || [];
    orderItems = itemsRes.data || [];
    containerItems = containerRes.data || [];
    printJobs = printRes.data || [];
    simulationState = simRes.data || null;
    updatePrinterStatus();
    updateSharedClock();
    startCourierLoop();
    startPrinterLoop();
    return true;
  } catch (error) {
    console.error(error);
    document.getElementById("content").innerHTML = `<div class="card error-note"><b>Nie udało się odczytać wspólnych danych.</b><br>${escapeHtml(error.message || String(error))}</div>`;
    return false;
  }
}

function subscribeRealtime() {
  if (channelsStarted) return;
  channelsStarted = true;
  ["orders", "warehouse_slots", "order_items", "container_items", "print_jobs", "simulation_state"].forEach(table => {
    supabaseClient.channel(`live-${table}`)
      .on("postgres_changes", { event: "*", schema: "public", table }, async () => {
        await loadAllData();
        if (currentRole) renderCurrentRole();
      })
      .subscribe();
  });
}

function renderCurrentRole() {
  const title = document.getElementById("roleTitle");
  const content = document.getElementById("content");
  if (currentRole === "admin") return renderAdmin(title, content);
  if (simulationState && simulationState.round_status !== "running") {
    title.innerText = "Symulator Lean Management";
    content.innerHTML = `<div class="card waiting-note"><h3>Oczekiwanie na START rundy</h3><p>Prowadząca wyjaśnia zadanie. Po uruchomieniu rundy ekran odświeży się automatycznie, a wspólny czas ruszy od 08:00.</p></div>`;
    return;
  }
  if (currentRole === "A") renderDepartmentA(title, content);
  if (currentRole === "B") renderDepartmentB(title, content);
  if (currentRole === "C") renderDepartmentC(title, content);
  if (currentRole === "D") renderDepartmentD(title, content);
}

function itemsForOrder(orderId) {
  return orderItems.filter(item => item.order_id === orderId);
}

function containerForOrder(orderId) {
  return containerItems.filter(item => item.order_id === orderId && item.quantity > 0);
}

function itemsListHtml(items) {
  if (!items.length) return `<div>Brak pozycji.</div>`;
  return `<ul>${items.map(item => `<li>${escapeHtml(item.product)} × ${item.quantity}${item.condition ? `, stan: ${escapeHtml(item.condition)}` : ""}</li>`).join("")}</ul>`;
}

function renderAdmin(title, content) {
  title.innerText = "Panel prowadzącej — koszyk wieloproduktowy";
  const products = [...new Set(warehouseSlots.map(x => x.product))].sort();
  const requests = orders.filter(o => o.data_issue_status === "requested");
  content.innerHTML = `
    <div class="card success-note">Połączenie ze wspólną bazą działa.</div>
    ${roundControlHtml()}
    ${studentRoundSummaryHtml()}
    ${requests.length ? `<div class="card customer-contact"><h3>Prośby o kontakt z klientem (${requests.length})</h3>${requests.map(customerRequestHtml).join("")}</div>` : ""}
    <div class="card">
      <h3>Nowe zamówienie</h3>
      <input id="clientName" placeholder="Imię i nazwisko" value="${escapeHtml(orderDraft.customerName)}">
      <input id="clientEmail" placeholder="E-mail" value="${escapeHtml(orderDraft.customerEmail)}">
      <input id="clientPhone" placeholder="Telefon" value="${escapeHtml(orderDraft.customerPhone)}">
      <input id="clientAddress" placeholder="Adres" value="${escapeHtml(orderDraft.customerAddress)}">
      <select id="delivery"><option ${orderDraft.delivery === "Paczkomat" ? "selected" : ""}>Paczkomat</option><option ${orderDraft.delivery === "Kurier" ? "selected" : ""}>Kurier</option></select>
      <hr>
      <h4>Dodaj produkt do koszyka</h4>
      <select id="cartProduct">${products.map(p => `<option>${escapeHtml(p)}</option>`).join("")}</select>
      <input id="cartQuantity" type="number" min="1" value="1">
      <button type="button" onclick="addToCart()">Dodaj do koszyka</button>
      <div class="cart-box"><h4>Koszyk</h4>${cartHtml()}</div>
      <label class="checkbox-row"><input type="checkbox" id="badEmail" ${orderDraft.badEmail ? "checked" : ""}> Celowo błędny e-mail</label>
      <button id="createButton" onclick="createOrder()">Utwórz zamówienie</button>
    </div>
    <div class="card"><h3>Wspólne zamówienia (${orders.length})</h3>${orders.map(adminOrderHtml).join("") || "Brak zamówień."}</div>`;
}



function roundControlHtml() {
  const status = simulationState?.round_status || "waiting";
  if (status === "running") {
    return `<div class="card round-control running"><h3>Runda AS-IS</h3><div><b>Status:</b> RUNDA W TOKU</div><div><b>Czas firmowy:</b> ${formatMinute(getSimulationMinute())}</div></div>`;
  }
  return `<div class="card round-control waiting"><h3>Runda AS-IS</h3><div><b>Status:</b> OCZEKIWANIE NA START</div><div><b>Czas firmowy:</b> 08:00</div><button onclick="startRound()">START RUNDY</button></div>`;
}

async function startRound() {
  if (!confirm("Uruchomić rundę AS-IS? Wspólny zegar wszystkich stanowisk ruszy od 08:00.")) return;
  const { data, error } = await supabaseClient.from("simulation_state").update({
    round_status: "running",
    started_at: new Date().toISOString(),
    start_minute: 480,
    courier_processed: false,
    courier_processed_at: null
  }).eq("id", 1).eq("round_status", "waiting").select("id");
  if (error) return alert(error.message);
  if (!data || !data.length) return alert("Runda została już uruchomiona w innym oknie.");
  await loadAllData();
  renderCurrentRole();
}
function metricTile(label, value) {
  return `<div class="metric-tile">
    <span>${escapeHtml(label)}</span>
    <strong>${value}</strong>
  </div>`;
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return "—";

  const total = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(total / 60);
  const remainingSeconds = Math.floor(total % 60);

  return `${minutes} min ${String(remainingSeconds).padStart(2, "0")} s`;
}
function studentRoundSummaryHtml() {
  const completed = orders.filter(o => o.status === "SHIPPED");
  const inProcess = orders.filter(o => ["A","B","C","D","READY"].includes(o.status));
  const waitingCustomer = orders.filter(o => o.data_issue_status === "requested").length;
  const reworkTotal = orders.reduce((sum,o) => sum + Number(o.return_count || 0), 0);
  const extraClicks = orders.reduce((sum,o) => sum + Number(o.search_clicks || 0), 0);
  const queuedPrint = printJobs.filter(j => j.status === "queued").length;
  const missed = orders.filter(o => o.missed_courier).length;
  const picking = orders.filter(o => o.picking_time_seconds != null);
  const packing = orders.filter(o => o.packing_time_seconds != null);
  const avg = (list, key) => list.length ? Math.round(list.reduce((sum,o) => sum + Number(o[key] || 0),0) / list.length) : null;
  return `<div class="card round-summary">
    <h3>Dane do analizy rundy AS-IS</h3>
    <p>Ta sekcja zawiera pomiary procesu. Interpretację danych wykonują uczestnicy.</p>
    <div class="metric-grid">
      ${metricTile("Zamówienia w toku", inProcess.length)}
      ${metricTile("Zamówienia wysłane", completed.length)}
      ${metricTile("Oczekujące na klienta", waitingCustomer)}
      ${metricTile("Liczba zwrotów/poprawek", reworkTotal)}
      ${metricTile("Dodatkowe kliknięcia magazynu", extraClicks)}
      ${metricTile("Dokumenty w kolejce drukarki", queuedPrint)}
      ${metricTile("Nie zdążyły na kuriera", missed)}
    </div>
    <div class="metrics-detail">
      <div>Średni czas kompletacji B: <b>${formatDuration(avg(picking,"picking_time_seconds"))}</b></div>
      <div>Średni czas kontroli i pakowania C: <b>${formatDuration(avg(packing,"packing_time_seconds"))}</b></div>
    </div>
    <h4>Pytania do VSM</h4>
    <ol>
      <li>Gdzie gromadziła się praca w toku?</li>
      <li>W których miejscach procesu pojawiało się oczekiwanie?</li>
      <li>Które czynności wykonywano ponownie?</li>
      <li>Gdzie przepływ informacji był niepełny lub opóźniony?</li>
      <li>Jakie zdarzenia mogły wydłużyć całkowity czas realizacji zamówienia?</li>
      <li>Co mogło wpłynąć na to, że część przesyłek nie zdążyła na odbiór kuriera?</li>
    </ol>
  </div>`;
}

function customerRequestHtml(order) {
  return `<div class="data-issue-card"><b>Zamówienie ${order.order_number}</b><br>Problem zgłoszony przez Dział A: <b>${escapeHtml(issueLabel(order.data_issue_type))}</b><br><button onclick="answerCustomerRequest(${order.id})">Odpowiedz jako klient</button></div>`;
}

function issueLabel(type) {
  return ({ email: "Błędny e-mail", phone: "Błędny numer telefonu", address: "Niepełny lub błędny adres", delivery: "Błędne dane dostawy", other: "Inny problem" })[type] || type || "Nieokreślony problem";
}

async function answerCustomerRequest(orderId) {
  const order = orders.find(o => o.id === orderId);
  if (!order) return;
  let field = null;
  let promptText = "Wpisz poprawną wartość:";
  if (order.data_issue_type === "email") { field = "corrected_email"; promptText = "Wpisz poprawny e-mail klienta:"; }
  if (order.data_issue_type === "phone") { field = "corrected_phone"; promptText = "Wpisz poprawny numer telefonu klienta:"; }
  if (order.data_issue_type === "address") { field = "corrected_address"; promptText = "Wpisz poprawny adres klienta:"; }
  if (!field) {
    const note = prompt("Wpisz poprawione dane lub instrukcję dla Działu A:");
    if (!note) return;
    field = "corrected_address";
    promptText = null;
    var value = note;
  } else {
    var value = prompt(promptText);
    if (!value) return;
  }
  const update = { data_issue_status: "answered", data_issue_resolved_at: new Date().toISOString() };
  update[field] = value.trim();
  const { error } = await supabaseClient.from("orders").update(update).eq("id", orderId).eq("data_issue_status", "requested");
  if (error) return alert(error.message);
  await loadAllData(); renderCurrentRole();
}
function saveOrderDraft() {
  const name = document.getElementById("clientName");
  if (!name) return;
  orderDraft = {
    customerName: name.value,
    customerEmail: document.getElementById("clientEmail").value,
    customerPhone: document.getElementById("clientPhone").value,
    customerAddress: document.getElementById("clientAddress").value,
    delivery: document.getElementById("delivery").value,
    badEmail: document.getElementById("badEmail").checked
  };
}

function addToCart() {
  saveOrderDraft();
  const product = document.getElementById("cartProduct").value;
  const quantity = Math.max(1, Number(document.getElementById("cartQuantity").value) || 1);
  const existing = cart.find(x => x.product === product);
  if (existing) existing.quantity += quantity;
  else cart.push({ product, quantity });
  renderCurrentRole();
}

function removeFromCart(index) {
  saveOrderDraft();
  cart.splice(index, 1);
  renderCurrentRole();
}

function cartHtml() {
  if (!cart.length) return `<div>Koszyk jest pusty.</div>`;
  return cart.map((item, index) => `<div class="cart-line"><span>${escapeHtml(item.product)} × ${item.quantity}</span><button class="secondary" onclick="removeFromCart(${index})">Usuń</button></div>`).join("");
}

function adminOrderHtml(order) {
  return `<div class="card"><b>Zamówienie ${order.order_number}</b><br>Klient: ${escapeHtml(order.customer_name)}<br>Status: ${escapeHtml(order.status)}${order.return_count ? `<br>Zwroty/poprawki: ${order.return_count}` : ""}${itemsListHtml(itemsForOrder(order.id))}</div>`;
}

async function createOrder() {
  if (!cart.length) return alert("Dodaj co najmniej jeden produkt do koszyka.");
  const button = document.getElementById("createButton");
  button.disabled = true;
  try {
    let email = document.getElementById("clientEmail").value.trim();
    if (document.getElementById("badEmail").checked) email = email.replace("@", "");
    const maxNumber = orders.reduce((m, o) => Math.max(m, Number(o.order_number) || 1000), 1000);
    const totalQuantity = cart.reduce((sum, item) => sum + item.quantity, 0);
    const { data: orderData, error: orderError } = await supabaseClient.from("orders").insert({
      order_number: maxNumber + 1,
      customer_name: document.getElementById("clientName").value.trim(),
      email,
      phone: document.getElementById("clientPhone").value.trim(),
      address: document.getElementById("clientAddress").value.trim(),
      delivery: document.getElementById("delivery").value,
      product: cart[0].product,
      quantity: totalQuantity,
      status: "A",
      search_clicks: 0,
      printer_wait_seconds: 0,
      picked_quantity: 0,
      hidden_issue: "none"
    }).select("id, order_number").single();
    if (orderError) throw orderError;

    const rows = cart.map(item => ({ order_id: orderData.id, product: item.product, quantity: item.quantity }));
    const { error: itemsError } = await supabaseClient.from("order_items").insert(rows);
    if (itemsError) throw itemsError;

    cart = [];
    orderDraft = { customerName: "", customerEmail: "", customerPhone: "", customerAddress: "", delivery: "Paczkomat", badEmail: false };
    await loadAllData();
    renderCurrentRole();
    alert(`Utworzono zamówienie ${orderData.order_number}.`);
  } catch (error) {
    alert(`Nie udało się utworzyć zamówienia: ${error.message || error}`);
  } finally {
    const currentButton = document.getElementById("createButton");
    if (currentButton) currentButton.disabled = false;
  }
}

function renderDepartmentA(title, content) {
  title.innerText = "Dział A - Obsługa zamówień";
  const list = orders.filter(o => o.status === "A");
  const active = list.filter(o => !["requested"].includes(o.data_issue_status));
  const waiting = list.filter(o => o.data_issue_status === "requested");
  content.innerHTML = `
    <div class="card"><h3>Instrukcja</h3><p>Przejmij zamówienie, sprawdź dane klienta, sposób dostawy i wszystkie pozycje koszyka. Jeżeli dane są błędne, zgłoś problem i poczekaj na odpowiedź klienta.</p></div>
    ${stationSelector("A")}
    <h3>Nowe i aktywne zamówienia (${active.length})</h3>
    ${active.map(departmentAOrderHtml).join("") || `<div class="card">Brak aktywnych zamówień.</div>`}
    <h3>Oczekujące na klienta (${waiting.length})</h3>
    ${waiting.map(departmentAOrderHtml).join("") || `<div class="card">Brak zamówień oczekujących.</div>`}`;
}

function departmentAOrderHtml(order) {
  const issueStatus = order.data_issue_status || "none";
  const claimed = order.claimed_by || "";
  let action = "";

  if (!currentStation.startsWith("A")) {
    action = `<div class="claimed-note">Najpierw wybierz stanowisko A1-A5.</div>`;
  } else if (!claimed) {
    action = `<button onclick="claimOrder(${order.id}, 'A')">Przejmij zamówienie</button>`;
  } else if (claimed !== currentStation) {
    action = `<div class="claimed-note">Obsługuje: <b>${escapeHtml(claimed)}</b></div>`;
  } else if (issueStatus === "requested") {
    action = `<div class="waiting-note"><b>Oczekiwanie na odpowiedź klienta</b><br>Zgłoszony problem: ${escapeHtml(issueLabel(order.data_issue_type))}</div>`;
  } else if (issueStatus === "answered") {
    action = `<div class="answer-note"><b>Odpowiedź klienta:</b><br>${correctionHtml(order)}</div><button onclick="applyCustomerCorrection(${order.id})">Zastosuj korektę i ponownie zweryfikuj</button>`;
  } else {
    const recheck = issueStatus === "recheck" ? `<div class="answer-note"><b>Ponowna weryfikacja po korekcie.</b><br>Sprawdź, czy nowe dane są rzeczywiście poprawne. Jeśli nie, zgłoś problem ponownie.</div>` : "";
    const returnedFromD = order.data_issue_return_to === "D";
    const printState = printStateFor(order.id, "order_card");
    const printAction = returnedFromD
      ? `<div class="waiting-note"><b>Paczka wstrzymana w Dziale D.</b><br>Po potwierdzeniu korekty zamówienie wróci bezpośrednio do wysyłki.</div><button onclick="verifyAndRouteOrder(${order.id})">Zweryfikowano, odeślij do D</button>`
      : order.order_card_printed
        ? `<div class="success-note">Karta zamówienia wydrukowana.</div><button onclick="verifyAndRouteOrder(${order.id})">Zweryfikowano i przekaż do B</button>`
        : printState
          ? `<div class="waiting-note">Karta zamówienia: ${escapeHtml(printState)}</div>`
          : `<button onclick="queuePrint(${order.id}, 'A', 'order_card')">Wyślij kartę zamówienia do drukarki</button>`;
    action = `${recheck}${printAction}<button class="secondary" onclick="reportDataIssue(${order.id})">Zgłoś problem z danymi</button>`;
  }

  return `<div class="card ${issueStatus === "requested" ? "waiting-card" : ""}"><b>Zamówienie ${order.order_number}</b>${claimed ? `<br>Obsługuje: <b>${escapeHtml(claimed)}</b>` : ""}<br>Klient: ${escapeHtml(order.customer_name)}<br>E-mail: ${escapeHtml(order.email)}<br>Telefon: ${escapeHtml(order.phone)}<br>Adres: ${escapeHtml(order.address)}<br>Dostawa: ${escapeHtml(order.delivery)}${itemsListHtml(itemsForOrder(order.id))}${action}</div>`;
}

function correctionHtml(order) {
  if (order.data_issue_type === "email") return `Poprawny e-mail: <b>${escapeHtml(order.corrected_email)}</b>`;
  if (order.data_issue_type === "phone") return `Poprawny telefon: <b>${escapeHtml(order.corrected_phone)}</b>`;
  return `Poprawione dane: <b>${escapeHtml(order.corrected_address)}</b>`;
}

async function reportDataIssue(orderId) {
  const order = orders.find(o => o.id === orderId);
  if (!order || order.claimed_by !== currentStation) return alert("To zamówienie nie jest przypisane do Twojego stanowiska.");
  const choice = prompt("Wpisz numer problemu:\n1 - błędny e-mail\n2 - błędny telefon\n3 - niepełny adres\n4 - dane dostawy\n5 - inny problem");
  const type = ({ "1": "email", "2": "phone", "3": "address", "4": "delivery", "5": "other" })[choice];
  if (!type) return;
  const { error } = await supabaseClient.from("orders").update({ data_issue_type: type, data_issue_status: "requested", data_issue_reported_at: new Date().toISOString(), data_issue_resolved_at: null }).eq("id", orderId).eq("status", "A").eq("claimed_by", currentStation);
  if (error) return alert(error.message);
  await loadAllData(); renderCurrentRole();
}

async function applyCustomerCorrection(orderId) {
  const order = orders.find(o => o.id === orderId);
  if (!order || order.data_issue_status !== "answered" || order.claimed_by !== currentStation) return;
  const update = { data_issue_status: "recheck" };
  if (order.data_issue_type === "email") update.email = order.corrected_email;
  else if (order.data_issue_type === "phone") update.phone = order.corrected_phone;
  else if (order.data_issue_type === "address") update.address = order.corrected_address;
  else update.address = order.corrected_address || order.address;
  const { error } = await supabaseClient.from("orders").update(update).eq("id", orderId).eq("status", "A").eq("claimed_by", currentStation);
  if (error) return alert(error.message);
  await loadAllData(); renderCurrentRole();
}

async function verifyAndRouteOrder(orderId) {
  const order = orders.find(o => o.id === orderId);
  if (!order || order.claimed_by !== currentStation) return alert("To zamówienie nie jest przypisane do Twojego stanowiska.");
  if (["requested", "answered"].includes(order.data_issue_status)) return alert("Najpierw zakończ obsługę zgłoszonego problemu z danymi.");
  const target = order.data_issue_return_to === "D" ? "D" : "B";
  if (target === "B" && !order.order_card_printed) return alert("Najpierw wydrukuj kartę zamówienia.");
  const { error } = await supabaseClient.from("orders").update({ status: target, claimed_by: null, data_issue_return_to: null }).eq("id", orderId).eq("status", "A").eq("claimed_by", currentStation);
  if (error) return alert(error.message);
  await loadAllData(); renderCurrentRole();
}
function renderDepartmentB(title, content) {
  title.innerText = "Dział B - Magazyn i kompletacja";
  const list = orders.filter(o => o.status === "B");
  content.innerHTML = `
    <div class="card"><h3>Instrukcja</h3><p>Kompletuj pozycje do wspólnego pojemnika. Zamówienia oznaczone jako poprawka wymagają najpierw usunięcia niezgodnej zawartości.</p></div>
    ${stationSelector("B")}
    <h3>Nowe i zwrócone zamówienia (${list.length})</h3>
    ${list.map(departmentBOrderHtml).join("") || `<div class="card">Brak zamówień.</div>`}`;
}

function stationSelector(prefix) {
  return `<div class="station-box"><b>Twoje stanowisko:</b><br><select onchange="setStation(this.value)"><option value="">-- wybierz --</option>${[1,2,3,4,5].map(n => `<option value="${prefix}${n}" ${currentStation === `${prefix}${n}` ? "selected" : ""}>${prefix}${n}</option>`).join("")}</select>${currentStation.startsWith(prefix) ? `<span> Aktywne: <b>${currentStation}</b></span>` : ""}</div>`;
}

function setStation(value) {
  currentStation = value;
  sessionStorage.setItem("leanStation", value);
  returnMode = null;
  renderCurrentRole();
}

function departmentBOrderHtml(order) {
  const wanted = itemsForOrder(order.id);
  const actual = containerForOrder(order.id);
  const claimed = order.claimed_by || "";
  const rework = (order.return_count || 0) > 0;
  let actions = "";
  if (!currentStation.startsWith("B")) actions = `<div class="claimed-note">Najpierw wybierz stanowisko B1-B5.</div>`;
  else if (!claimed) actions = `<button onclick="claimOrder(${order.id}, 'B')">${rework ? "Przejmij poprawkę" : "Przejmij zamówienie"}</button>`;
  else if (claimed !== currentStation) actions = `<div class="claimed-note">Obsługuje: <b>${escapeHtml(claimed)}</b></div>`;
  else if (!order.picking_started_at) actions = `<button onclick="startPicking(${order.id})">${rework ? "Rozpocznij poprawkę" : "Rozpocznij kompletację"}</button>`;
  else actions = bWorkingHtml(order, wanted, actual, rework);

  return `<div class="card ${rework ? "rework-card" : ""}">${rework ? `<div class="rework-title">ZAMÓWIENIE DO POPRAWY, zwrot z Działu C</div>` : ""}<b>Zamówienie ${order.order_number}</b><h4>Do skompletowania</h4>${itemsListHtml(wanted)}<h4>W pojemniku</h4>${containerListHtml(order, actual)}<div>Zwroty/poprawki: ${order.return_count || 0}</div><br>${actions}</div>`;
}

function containerListHtml(order, actual) {
  if (!actual.length) return `<div>Pojemnik jest pusty.</div>`;
  return `<ul>${actual.map(item => `<li>${escapeHtml(item.product)} × ${item.quantity}, stan: ${escapeHtml(item.condition)} ${order.claimed_by === currentStation && currentStation.startsWith("B") ? `<button class="secondary" onclick="beginReturn(${order.id}, ${item.id})">Wyjmij i odłóż</button>` : ""}</li>`).join("")}</ul>`;
}

function bWorkingHtml(order, wanted, actual, rework) {
  const message = returnMode && returnMode.orderId === order.id
    ? `<div class="warehouse-note"><b>Tryb odkładania:</b> znajdź miejsce z produktem „${escapeHtml(returnMode.product)}” i kliknij je.</div>`
    : `<div class="warehouse-note">Kliknięty produkt zostanie włożony do pojemnika. Porównuj zawartość z kartą zamówienia.</div>`;
  return `<div class="claimed-note">Obsługuje: <b>${escapeHtml(order.claimed_by)}</b></div>${message}<button onclick="finishPicking(${order.id})">${rework ? "Poprawka gotowa, przekaż ponownie do C" : "Kompletacja gotowa"}</button>${warehouseHtml(order)}`;
}

function warehouseHtml(order) {
  return `<div class="warehouse-wrap"><div class="warehouse-grid">${warehouseSlots.map(slot => `<button class="slot ${slot.quantity <= 0 ? "empty" : ""}" ${slot.quantity <= 0 && !returnMode ? "disabled" : ""} onclick="handleWarehouseClick(${order.id}, ${slot.id})"><span>${escapeHtml(slot.slot_name)}</span><strong>${escapeHtml(slot.product)}</strong><small>Dostępne: ${slot.quantity}</small></button>`).join("")}</div></div>`;
}

async function claimOrder(orderId, prefix) {
  if (!currentStation.startsWith(prefix)) return alert(`Najpierw wybierz stanowisko ${prefix}1-${prefix}5.`);
  const { data, error } = await supabaseClient.from("orders").update({ claimed_by: currentStation }).eq("id", orderId).is("claimed_by", null).select("id");
  if (error) return alert(error.message);
  if (!data.length) alert("Zamówienie zostało już przejęte.");
  await loadAllData(); renderCurrentRole();
}

async function startPicking(orderId) {
  const { error } = await supabaseClient.from("orders").update({ picking_started_at: new Date().toISOString() }).eq("id", orderId).eq("claimed_by", currentStation);
  if (error) return alert(error.message);
  await loadAllData(); renderCurrentRole();
}

function beginReturn(orderId, containerItemId) {
  const item = containerItems.find(x => x.id === containerItemId);
  if (!item) return;
  returnMode = { orderId, containerItemId, product: item.product };
  renderCurrentRole();
}

async function handleWarehouseClick(orderId, slotId) {
  const order = orders.find(x => x.id === orderId);
  const slot = warehouseSlots.find(x => x.id === slotId);
  if (!order || !slot || order.claimed_by !== currentStation) return;
  if (returnMode && returnMode.orderId === orderId) return returnItemToSlot(order, slot);
  return addItemFromSlot(order, slot);
}

async function addItemFromSlot(order, slot) {
  if (slot.quantity <= 0) return alert("To miejsce jest puste.");
  const current = containerItems.find(x => x.order_id === order.id && x.product === slot.product && x.condition === "bez widocznych uszkodzen");
  try {
    const { data, error } = await supabaseClient.from("warehouse_slots").update({ quantity: slot.quantity - 1 }).eq("id", slot.id).eq("quantity", slot.quantity).select("id");
    if (error) throw error;
    if (!data.length) return alert("Stan zmienił się na innym stanowisku. Spróbuj ponownie.");
    if (current) {
      const { error: e2 } = await supabaseClient.from("container_items").update({ quantity: current.quantity + 1 }).eq("id", current.id);
      if (e2) throw e2;
    } else {
      const { error: e2 } = await supabaseClient.from("container_items").insert({ order_id: order.id, product: slot.product, quantity: 1, condition: "bez widocznych uszkodzen" });
      if (e2) throw e2;
    }
    await loadAllData(); renderCurrentRole();
  } catch (error) { alert(`Nie udało się pobrać produktu: ${error.message || error}`); }
}

async function returnItemToSlot(order, slot) {
  const item = containerItems.find(x => x.id === returnMode.containerItemId);
  if (!item) return;
  if (slot.product !== item.product) {
    await incrementClick(order);
    return alert("To nie jest miejsce z odkładanym produktem. Szukaj dalej.");
  }
  try {
    const { error: slotError } = await supabaseClient.from("warehouse_slots").update({ quantity: slot.quantity + 1 }).eq("id", slot.id).eq("quantity", slot.quantity);
    if (slotError) throw slotError;
    if (item.quantity > 1) {
      const { error } = await supabaseClient.from("container_items").update({ quantity: item.quantity - 1 }).eq("id", item.id);
      if (error) throw error;
    } else {
      const { error } = await supabaseClient.from("container_items").delete().eq("id", item.id);
      if (error) throw error;
    }
    returnMode = null;
    await loadAllData(); renderCurrentRole();
  } catch (error) { alert(`Nie udało się odłożyć produktu: ${error.message || error}`); }
}

async function incrementClick(order) {
  await supabaseClient.from("orders").update({ search_clicks: (order.search_clicks || 0) + 1 }).eq("id", order.id);
  await loadAllData(); renderCurrentRole();
}

async function finishPicking(orderId) {
  const order = orders.find(x => x.id === orderId);
  const wanted = itemsForOrder(orderId);
  const actual = containerForOrder(orderId);
  const wantedTotal = wanted.reduce((s, x) => s + x.quantity, 0);
  const actualTotal = actual.reduce((s, x) => s + x.quantity, 0);
  if (actualTotal < wantedTotal) return alert(`W pojemniku jest ${actualTotal} szt., a karta zamówienia wymaga ${wantedTotal} szt.`);
  const started = new Date(order.picking_started_at).getTime();
  const seconds = Math.max(1, Math.floor((Date.now() - started) / 1000));
  const { error } = await supabaseClient.from("orders").update({ status: "C", picking_time_seconds: seconds, claimed_by: null, packing_started_at: null }).eq("id", orderId).eq("claimed_by", currentStation);
  if (error) return alert(error.message);
  returnMode = null;
  await loadAllData(); renderCurrentRole();
}

function renderDepartmentC(title, content) {
  title.innerText = "Dział C - Kontrola i pakowanie";
  const list = orders.filter(o => o.status === "C");
  content.innerHTML = `<div class="card"><h3>Instrukcja</h3><p>Porównaj wszystkie pozycje karty zamówienia z faktyczną zawartością pojemnika.</p></div>${stationSelector("C")}<h3>Kolejka (${list.length})</h3>${list.map(departmentCOrderHtml).join("") || `<div class="card">Brak zamówień.</div>`}`;
}

function departmentCOrderHtml(order) {
  const claimed = order.claimed_by || "";
  let action = "";
  if (!currentStation.startsWith("C")) action = `<div class="claimed-note">Najpierw wybierz stanowisko C1-C5.</div>`;
  else if (!claimed) action = `<button onclick="claimOrder(${order.id}, 'C')">Przejmij zamówienie</button>`;
  else if (claimed !== currentStation) action = `<div class="claimed-note">Obsługuje: <b>${escapeHtml(claimed)}</b></div>`;
  else if (!order.packing_started_at) action = `<button onclick="startPacking(${order.id})">Rozpocznij kontrolę i pakowanie</button>`;
  else action = cWorkingHtml(order);
  return `<div class="card"><b>Zamówienie ${order.order_number}</b><br>Zwroty/poprawki: ${order.return_count || 0}<br>${action}</div>`;
}

function cWorkingHtml(order) {
  return `<div class="quality-compare"><div class="quality-box expected"><h4>Karta zamówienia</h4>${itemsListHtml(itemsForOrder(order.id))}</div><div class="quality-box actual"><h4>Faktyczna zawartość pojemnika</h4>${itemsListHtml(containerForOrder(order.id))}</div></div><div class="packing-checklist">${["Sprawdź zgodność produktów","Sprawdź liczbę sztuk","Sprawdź stan produktów","Sprawdź kartę zamówienia","Zabezpiecz produkty","Zamknij paczkę","Oznacz paczkę numerem zamówienia"].map(t => `<label><input type="checkbox" class="pack-check-${order.id}"> ${t}</label>`).join("")}</div><button onclick="finishPacking(${order.id})">Pakowanie zakończone, przekaż do D</button><button class="secondary" onclick="reportProblem(${order.id})">Zgłoś niezgodność</button>`;
}

async function startPacking(orderId) {
  const { error } = await supabaseClient.from("orders").update({ packing_started_at: new Date().toISOString() }).eq("id", orderId).eq("claimed_by", currentStation);
  if (error) return alert(error.message);
  await loadAllData(); renderCurrentRole();
}

async function finishPacking(orderId) {
  const checks = [...document.querySelectorAll(`.pack-check-${orderId}`)];
  if (!checks.length || checks.some(x => !x.checked)) return alert("Wykonaj wszystkie czynności kontrolne i pakowania.");
  const order = orders.find(x => x.id === orderId);
  const seconds = Math.max(1, Math.floor((Date.now() - new Date(order.packing_started_at).getTime()) / 1000));
  const { error } = await supabaseClient.from("orders").update({ status: "D", packing_time_seconds: seconds, claimed_by: null }).eq("id", orderId).eq("claimed_by", currentStation);
  if (error) return alert(error.message);
  await loadAllData(); renderCurrentRole();
}

async function reportProblem(orderId) {
  const reason = prompt("Wpisz stwierdzoną niezgodność:");
  if (!reason) return;
  const order = orders.find(x => x.id === orderId);
  const { error } = await supabaseClient.from("orders").update({ status: "B", claimed_by: null, picking_started_at: null, packing_started_at: null, return_count: (order.return_count || 0) + 1 }).eq("id", orderId).eq("claimed_by", currentStation);
  if (error) return alert(error.message);
  await loadAllData(); renderCurrentRole();
}

function renderDepartmentD(title, content) {
  title.innerText = "Dział D - Wysyłka";
  const list = orders.filter(o => o.status === "D");
  content.innerHTML = `
    <div class="card"><h3>Instrukcja</h3><p>Przejmij paczkę, sprawdź dane wysyłkowe, wydrukuj etykietę na wspólnej drukarce i przygotuj przesyłkę.</p></div>
    ${stationSelector("D")}
    <h3>Paczki do wysyłki (${list.length})</h3>
    ${list.map(departmentDOrderHtml).join("") || `<div class="card">Brak paczek.</div>`}
    ${shippingZoneHtml()}`;
}

function departmentDOrderHtml(order) {
  const claimed = order.claimed_by || "";
  const state = printStateFor(order.id, "shipping_label");
  let action = "";
  if (!currentStation.startsWith("D")) action = `<div class="claimed-note">Najpierw wybierz stanowisko D1-D5.</div>`;
  else if (!claimed) action = `<button onclick="claimOrder(${order.id}, 'D')">Przejmij paczkę</button>`;
  else if (claimed !== currentStation) action = `<div class="claimed-note">Obsługuje: <b>${escapeHtml(claimed)}</b></div>`;
  else if (order.shipping_label_printed) action = `<div class="success-note">Etykieta wydrukowana.</div><button onclick="finishShipping(${order.id})">Odłóż do strefy wysyłki</button>`;
  else if (state) action = `<div class="waiting-note">Etykieta: ${escapeHtml(state)}</div>`;
  else action = `<button onclick="queuePrint(${order.id}, 'D', 'shipping_label')">Wyślij etykietę do drukarki</button><button class="secondary" onclick="reportShippingDataIssue(${order.id})">Zgłoś problem z danymi wysyłkowymi</button>`;
  return `<div class="card"><b>Zamówienie ${order.order_number}</b><br>Klient: ${escapeHtml(order.customer_name)}<br>Adres: ${escapeHtml(order.address)}<br>Dostawa: ${escapeHtml(order.delivery)}${itemsListHtml(itemsForOrder(order.id))}${action}</div>`;
}

async function reportShippingDataIssue(orderId) {
  const order = orders.find(o => o.id === orderId);
  if (!order || order.claimed_by !== currentStation) return alert("Najpierw przejmij paczkę.");
  if (printStateFor(orderId, "shipping_label")) return alert("Etykieta jest już w kolejce. Problem zgłoś przed rozpoczęciem drukowania.");
  const choice = prompt("Wpisz numer problemu:\n1 - błędny e-mail\n2 - błędny telefon\n3 - niepełny lub błędny adres\n4 - błędne dane dostawy\n5 - inny problem");
  const type = ({ "1": "email", "2": "phone", "3": "address", "4": "delivery", "5": "other" })[choice];
  if (!type) return;
  const { error } = await supabaseClient.from("orders").update({
    status: "A",
    claimed_by: null,
    data_issue_type: type,
    data_issue_status: "requested",
    data_issue_reported_at: new Date().toISOString(),
    data_issue_resolved_at: null,
    data_issue_return_to: "D"
  }).eq("id", orderId).eq("status", "D").eq("claimed_by", currentStation);
  if (error) return alert(error.message);
  await loadAllData(); renderCurrentRole();
  alert("Paczka została wstrzymana, a sprawę przekazano do Działu A.");
}

async function finishShipping(orderId) {
  const order = orders.find(o => o.id === orderId);
  if (!order || order.claimed_by !== currentStation || !order.shipping_label_printed) return;
  const { error } = await supabaseClient.from("orders").update({ status: "READY", shipping_ready_at: new Date().toISOString(), claimed_by: null, missed_courier: simulationState ? simulationState.courier_processed : false }).eq("id", orderId).eq("claimed_by", currentStation);
  if (error) return alert(error.message);
  await loadAllData(); renderCurrentRole();
}



function getSimulationMinute() {
  if (!simulationState) return 480;
  if (simulationState.round_status !== "running") return Number(simulationState.start_minute || 480);
  const start = new Date(simulationState.started_at).getTime();
  const elapsed = Math.max(0, Date.now() - start);
  return Number(simulationState.start_minute) + Math.floor(elapsed / Number(simulationState.milliseconds_per_minute));
}

function formatMinute(total) {
  const normalized = Math.max(0, total);
  const h = Math.floor(normalized / 60) % 24;
  const m = normalized % 60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}

function updateSharedClock() {
  const minute = getSimulationMinute();
  const clock = document.getElementById("clock");
  if (clock) clock.innerText = formatMinute(minute);
  const courier = document.getElementById("courierStatus");
  if (courier && simulationState) {
    const cutoff = Number(simulationState.courier_minute);
    courier.innerText = simulationState.courier_processed ? "Odbiór zakończony" : minute >= cutoff ? "Kurier przyjechał" : `Przyjazd ${formatMinute(cutoff)}`;
  }
}

function startCourierLoop() {
  if (courierLoopStarted) return;
  courierLoopStarted = true;
  setInterval(async () => { updateSharedClock(); await processCourierPickup(); }, 1000);
}

async function processCourierPickup() {
  if (!simulationState || simulationState.round_status !== "running" || simulationState.courier_processed) return;
  if (getSimulationMinute() < Number(simulationState.courier_minute)) return;
  const nowIso = new Date().toISOString();
  const { data, error } = await supabaseClient.from("simulation_state").update({ courier_processed: true, courier_processed_at: nowIso }).eq("id", 1).eq("courier_processed", false).select("id");
  if (error || !data || !data.length) return;
  const readyIds = orders.filter(o => o.status === "READY").map(o => o.id);
  if (readyIds.length) await supabaseClient.from("orders").update({ status: "SHIPPED", shipped_at: nowIso, missed_courier: false }).in("id", readyIds);
  await loadAllData(); if (currentRole) renderCurrentRole();
}

function shippingZoneHtml() {
  const ready = orders.filter(o => o.status === "READY");
  const shipped = orders.filter(o => o.status === "SHIPPED");
  const afterPickup = simulationState && simulationState.courier_processed;
  const missed = afterPickup ? ready : [];
  return `<div class="card"><h3>Strefa wysyłkowa</h3>${ready.length ? ready.map(o => `<div>Zamówienie ${o.order_number} — ${afterPickup ? "nie zdążyło na kuriera" : "oczekuje na odbiór"}</div>`).join("") : "Brak paczek oczekujących."}${missed.length ? `<h4>Nie zdążyły na kuriera</h4>${missed.map(o => `<div>Zamówienie ${o.order_number}</div>`).join("")}` : ""}<h4>Odebrane przez kuriera: ${shipped.length}</h4></div>`;
}

function printStateFor(orderId, documentType) {
  const job = printJobs.find(j => j.order_id === orderId && j.document_type === documentType && ["queued", "printing"].includes(j.status));
  if (!job) return "";
  if (job.status === "printing") return "drukowanie";
  const queued = printJobs.filter(j => j.status === "queued").sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
  const pos = queued.findIndex(j => j.id === job.id) + 1;
  return pos > 0 ? `oczekuje w kolejce, pozycja ${pos}` : "oczekuje w kolejce";
}

async function queuePrint(orderId, department, documentType) {
  if (!currentStation.startsWith(department)) return alert(`Wybierz stanowisko Działu ${department}.`);
  const existing = printJobs.find(j => j.order_id === orderId && j.document_type === documentType && ["queued", "printing", "done"].includes(j.status));
  if (existing) return alert("Ten dokument jest już w kolejce lub został wydrukowany.");
  const queuedCount = printJobs.filter(j => j.status === "queued").length;
  const { error } = await supabaseClient.from("print_jobs").insert({ order_id: orderId, department, station: currentStation, document_type: documentType, status: "queued", queue_position: queuedCount + 1 });
  if (error) return alert(error.message);
  const timeField = documentType === "order_card" ? "order_card_print_requested_at" : "shipping_label_print_requested_at";
  const update = {}; update[timeField] = new Date().toISOString();
  await supabaseClient.from("orders").update(update).eq("id", orderId);
  await loadAllData(); renderCurrentRole(); processPrinterQueue();
}

function startPrinterLoop() {
  if (printerLoopStarted) return;
  printerLoopStarted = true;
  setInterval(processPrinterQueue, 1000);
}

async function processPrinterQueue() {
  if (!printJobs.length) { updatePrinterStatus(); return; }
  const now = Date.now();
  const printing = printJobs.find(j => j.status === "printing");
  if (printing) {
    const duration = printing.document_type === "order_card" ? 15000 : 20000;
    if (printing.started_at && now - new Date(printing.started_at).getTime() >= duration) {
      const { data } = await supabaseClient.from("print_jobs").update({ status: "done", finished_at: new Date().toISOString() }).eq("id", printing.id).eq("status", "printing").select("id");
      if (data && data.length) {
        const flag = printing.document_type === "order_card" ? { order_card_printed: true } : { shipping_label_printed: true };
        await supabaseClient.from("orders").update(flag).eq("id", printing.order_id);
        await loadAllData(); if (currentRole) renderCurrentRole();
      }
    }
    updatePrinterStatus();
    return;
  }
  const next = printJobs.filter(j => j.status === "queued").sort((a,b) => new Date(a.created_at) - new Date(b.created_at))[0];
  if (next) {
    await supabaseClient.from("print_jobs").update({ status: "printing", started_at: new Date().toISOString() }).eq("id", next.id).eq("status", "queued").select("id");
    await loadAllData(); if (currentRole) renderCurrentRole();
  }
  updatePrinterStatus();
}

function updatePrinterStatus() {
  const box = document.getElementById("printerStatus");
  if (!box) return;
  const printing = printJobs.find(j => j.status === "printing");
  const queued = printJobs.filter(j => j.status === "queued").length;
  if (printing) {
    box.innerText = `Zajęta: ${printing.department}${printing.station ? ` / ${printing.station}` : ""}, ${printing.document_type === "order_card" ? "karta zamówienia" : "etykieta"}; kolejka: ${queued}`;
    box.className = "printer-busy";
  } else {
    box.innerText = queued ? `Wolna, oczekuje w kolejce: ${queued}` : "Wolna";
    box.className = "printer-free";
  }
}

async function advanceOrder(id, status) {
  const { error } = await supabaseClient.from("orders").update({ status }).eq("id", id);
  if (error) return alert(error.message);
  await loadAllData(); renderCurrentRole();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[c]);
}

function updateClock() {
  updateSharedClock();
}

updateClock();
setInterval(updateClock, 1000);
