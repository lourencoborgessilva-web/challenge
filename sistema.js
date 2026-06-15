// ============================================================
//  GOODWE — Sistema de Gerenciamento de Recarga  |  Sprint 2
// ============================================================


// ── 1. CONFIGURAÇÕES ─────────────────────────────────────────

const CONFIG = {
    LIMITE_KW:    150,
    ALERTA_PCT:   0.80,
    CRITICO_PCT:  0.95,
    MAX_SESSOES:  8,
    TARIFA_BASE:  1.80,
    TICK_MS:      1000,
};

const FAIXAS = [
    { nome: "pico",    label: "Pico (+50%)",    horas: [6,7,8,17,18,19,20],      mult: 1.50 },
    { nome: "noturno", label: "Noturno (−20%)",  horas: [21,22,23,0,1,2,3,4,5],  mult: 0.80 },
    { nome: "normal",  label: "Normal",           horas: [],                       mult: 1.00 },
];

const DESCONTOS  = { comum: 0, assinante: 0.15, corporativo: 0.10 };
const TIPO_LABEL = { comum: "Comum", assinante: "Assinante GOODWE+", corporativo: "Corporativo" };

const OCPP_LABELS = { send: "[CP→CS]", recv: "[CS→CP]", error: "[ERROR ]", system: "[SYSTEM]", info: "[INFO  ]" };

const VIEWS_INFO = {
    dashboard:  { title: "Dashboard",  subtitle: "Visão geral do sistema de carregamento" },
    sessoes:    { title: "Sessões",    subtitle: "Gerencie todas as sessões de recarga simultâneas" },
    energia:    { title: "Energia",    subtitle: "Controle de demanda e distribuição de potência" },
    ocpp:       { title: "OCPP Log",   subtitle: "Protocolo de comunicação OCPP 1.6 em tempo real" },
    relatorios: { title: "Relatórios", subtitle: "Histórico e análise de todas as sessões realizadas" },
};

const REGRAS_CONFIG = [
    { t: "Limite de potência total",    d: () => `O eletroposto suporta até ${CONFIG.LIMITE_KW} kW simultâneos.` },
    { t: "Throttling automático (>95%)",d: () => `Acima de ${CONFIG.CRITICO_PCT*100}%, potência redistribuída igualmente entre sessões ativas.` },
    { t: "Alerta de atenção (80–95%)",  d: () => `Alerta registrado. Nenhuma redução de potência ainda.` },
    { t: "Restauração automática",      d: () => `Abaixo de ${CONFIG.ALERTA_PCT*100}%, potência original restaurada automaticamente.` },
    { t: "Máximo de sessões",           d: () => `Limite de ${CONFIG.MAX_SESSOES} sessões simultâneas.` },
];


// ── 2. ESTADO GLOBAL ──────────────────────────────────────────

const sessoes       = new Map();
const historico     = JSON.parse(localStorage.getItem("gw_historico")) || [];
const eventosDemanda = [];
let contadorSessao = 0, ocppMsgCount = 0, tickGlobal = null;


// ── 3. UTILITÁRIOS ────────────────────────────────────────────

const el  = id => document.getElementById(id);
const setText = (id, v) => { const e = el(id); if (e) e.textContent = v; };
const setHTML = (id, v) => { const e = el(id); if (e) e.innerHTML   = v; };
const pad2 = n => String(n).padStart(2, "0");
const horaAtual = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const formatarTempo = s => `${pad2(Math.floor(s/3600))}:${pad2(Math.floor((s%3600)/60))}:${pad2(s%60)}`;
const gerarMsgId = () => Math.random().toString(36).substring(2,10).toUpperCase();
const isAtiva = s => s.status === "carregando" || s.status === "throttled";


// ── 4. TARIFAÇÃO DINÂMICA ─────────────────────────────────────

function getFaixa(hora) {
    for (const f of FAIXAS)
        for (const h of f.horas)
            if (h === hora) return f;
    return FAIXAS[2];
}

function calcularTarifa(tipo, energia) {
    const faixa      = getFaixa(new Date().getHours());
    const descTotal  = (DESCONTOS[tipo] || 0) + (energia === "fotovoltaica" ? 0.05 : 0);
    const tarifaFinal = CONFIG.TARIFA_BASE * faixa.mult * (1 - descTotal);
    return { tarifaFinal, faixa, descTotal };
}


// ── 5. CONTROLE DE DEMANDA ────────────────────────────────────

const calcularPotenciaTotal = () =>
    [...sessoes.values()].reduce((t, s) => isAtiva(s) ? t + s.potenciaAtual : t, 0);

function aplicarControleDemanda() {
    const ativas = [...sessoes.values()].filter(isAtiva);
    if (!ativas.length) return;

    const pot          = calcularPotenciaTotal();
    const limCritico   = CONFIG.LIMITE_KW * CONFIG.CRITICO_PCT;
    const limAlerta    = CONFIG.LIMITE_KW * CONFIG.ALERTA_PCT;

    if (pot > limCritico) {
        const potPor = (CONFIG.LIMITE_KW * 0.90) / ativas.length;
        let houve = false;
        for (const s of ativas) {
            if (s.potenciaAtual > potPor) { s.potenciaAtual = potPor; s.status = "throttled"; houve = true; }
        }
        if (houve) {
            logEvento("crit", `Throttling ativado — ${ativas.length} sessão(ões) limitadas a ${potPor.toFixed(1)} kW cada`);
            ocpp("send", `[2,"${gerarMsgId()}","ChangeAvailability",{"connectorId":0,"type":"Inoperative"}]`);
        }
    } else if (pot <= limAlerta) {
        let restaurou = false;
        for (const s of ativas) {
            if (s.status === "throttled") { s.potenciaAtual = s.potenciaOriginal; s.status = "carregando"; restaurou = true; }
        }
        if (restaurou) {
            logEvento("ok", "Potência restaurada — demanda voltou ao nível normal");
            ocpp("send", `[2,"${gerarMsgId()}","ChangeAvailability",{"connectorId":0,"type":"Operative"}]`);
        }
    } else {
        logEvento("warn", `Atenção: demanda em ${((pot / CONFIG.LIMITE_KW) * 100).toFixed(0)}% do limite`);
    }
}

function logEvento(nivel, msg) {
    if (eventosDemanda[0]?.msg === msg) return;
    eventosDemanda.unshift({ nivel, msg, hora: horaAtual() });
    while (eventosDemanda.length > 50) eventosDemanda.pop();
    renderEventosDemanda();
}


// ── 6. OCPP 1.6 ───────────────────────────────────────────────

function ocpp(tipo, payload) {
    ocppMsgCount++;
    const log = el("ocpp-log");
    if (!log) return;
    const entry = document.createElement("div");
    entry.className = `ocpp-entry ocpp-${tipo}`;
    entry.innerHTML = `<span class="ocpp-time">${horaAtual()}</span><span class="ocpp-dir">${OCPP_LABELS[tipo]||`[${tipo}]`}</span><span class="ocpp-msg">${payload}</span>`;
    log.appendChild(entry);
    log.scrollTop = log.scrollHeight;
    setText("badge-ocpp", ocppMsgCount);
}

function ocppHandshake(s) {
    const id = gerarMsgId();
    ocpp("send", `[2,"${id}","BootNotification",{"chargePointModel":"GOODWE-DC50","chargePointVendor":"GOODWE","chargePointSerialNumber":"${s.id}"}]`);
    ocpp("recv", `[3,"${id}",{"currentTime":"${new Date().toISOString()}","interval":60,"status":"Accepted"}]`);
    ocpp("send", `[2,"${gerarMsgId()}","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Preparing"}]`);
    const id2 = gerarMsgId();
    ocpp("send", `[2,"${id2}","StartTransaction",{"connectorId":1,"idTag":"${s.id}","meterStart":0,"timestamp":"${new Date().toISOString()}"}]`);
    ocpp("recv", `[3,"${id2}",{"idTagInfo":{"status":"Accepted"},"transactionId":${s.transacaoId}}]`);
    ocpp("send", `[2,"${gerarMsgId()}","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"Charging"}]`);
}

function ocppMeter(s) {
    ocpp("send", `[2,"${gerarMsgId()}","MeterValues",{"connectorId":1,"transactionId":${s.transacaoId},"meterValue":[{"timestamp":"${new Date().toISOString()}","sampledValue":[{"value":"${s.energiaEntregueKwh.toFixed(2)}","measurand":"Energy.Active.Import.Register","unit":"kWh"},{"value":"${s.potenciaAtual.toFixed(1)}","measurand":"Power.Active.Import","unit":"kW"}]}]}]`);
}

function ocppStop(s) {
    const id = gerarMsgId();
    ocpp("send", `[2,"${id}","StopTransaction",{"idTag":"${s.id}","meterStop":${Math.round(s.energiaEntregueKwh*1000)},"timestamp":"${new Date().toISOString()}","transactionId":${s.transacaoId},"reason":"EVDisconnected"}]`);
    ocpp("recv", `[3,"${id}",{"idTagInfo":{"status":"Accepted"}}]`);
    ocpp("info", `Sessão ${s.id} encerrada. Energia: ${s.energiaEntregueKwh.toFixed(2)} kWh | Custo: R$ ${s.custoTotal.toFixed(2)}`);
}


// ── 7. GERENCIAMENTO DE SESSÕES ───────────────────────────────

function criarSessao(dados) {
    const regras = [
        { ok: () => dados.veiculo?.length >= 2,              msg: "Identificador muito curto." },
        { ok: () => dados.capacidade > 0 && dados.capacidade <= 200, msg: "Capacidade inválida (1–200 kWh)." },
        { ok: () => dados.inicial >= 0 && dados.inicial <= 99,       msg: "Bateria inicial inválida (0–99%)." },
        { ok: () => dados.desejada > dados.inicial,          msg: "Bateria desejada deve ser maior que a inicial." },
        { ok: () => dados.potencia > 0,                      msg: "Potência inválida." },
        { ok: () => sessoes.size < CONFIG.MAX_SESSOES,       msg: `Máximo de ${CONFIG.MAX_SESSOES} sessões atingido.` },
    ];

    const erros = regras.filter(r => !r.ok()).map(r => r.msg);
    if (erros.length) return { ok: false, erros };

    const id = `CP-${String(++contadorSessao).padStart(2, "0")}`;
    const { tarifaFinal, faixa, descTotal } = calcularTarifa(dados.tipo, dados.energia);

    const s = {
        id, veiculo: dados.veiculo.toUpperCase(), tipo: dados.tipo,
        capacidadeKwh: dados.capacidade, bateriaInicial: dados.inicial,
        bateriaAtual: dados.inicial, bateriaDesejada: dados.desejada,
        origemEnergia: dados.energia, potenciaOriginal: dados.potencia, potenciaAtual: dados.potencia,
        tarifaKwh: tarifaFinal, faixaTarifa: faixa.nome, faixaLabel: faixa.label,
        desconto: descTotal, energiaEntregueKwh: 0, custoTotal: 0,
        tempoSegundos: 0, status: "carregando", horarioInicio: horaAtual(),
        horarioFim: null, transacaoId: Math.floor(Math.random()*90000)+10000, tickMeter: 0,
    };

    sessoes.set(id, s);
    ocppHandshake(s);
    iniciarTick();
    renderizarTudo();
    return { ok: true, id };
}

function togglePausarSessao(id) {
    const s = sessoes.get(id);
    if (!s) return;
    const novoStatus = isAtiva(s) ? "pausado" : "carregando";
    const ocppStatus = novoStatus === "pausado" ? "SuspendedEV" : "Charging";
    s.status = novoStatus;
    ocpp("send", `[2,"${gerarMsgId()}","StatusNotification",{"connectorId":1,"errorCode":"NoError","status":"${ocppStatus}"}]`);
    renderizarTudo();
}

function encerrarSessao(s) {
    s.horarioFim = horaAtual();
    ocppStop(s);
    salvarNoHistorico(s);
    sessoes.delete(s.id);
    if (!sessoes.size) { clearInterval(tickGlobal); tickGlobal = null; }
}

// chamada via onclick no HTML (recebe id como string)
function finalizarSessao(id) {
    const s = sessoes.get(id);
    if (s) { encerrarSessao(s); renderizarTudo(); }
}

function salvarNoHistorico(s) {
    historico.unshift({
        id: s.id, veiculo: s.veiculo, tipo: TIPO_LABEL[s.tipo],
        bateriaInicial: s.bateriaInicial + "%", bateriaFinal: s.bateriaAtual.toFixed(0) + "%",
        energiaKwh: s.energiaEntregueKwh.toFixed(2), custo: "R$ " + s.custoTotal.toFixed(2),
        tarifa: "R$ " + s.tarifaKwh.toFixed(2) + "/kWh", faixa: s.faixaLabel,
        origem: s.origemEnergia === "fotovoltaica" ? "Fotovoltaica" : "Rede",
        tempo: formatarTempo(s.tempoSegundos), inicio: s.horarioInicio,
        fim: s.horarioFim, data: new Date().toLocaleDateString("pt-BR"),
    });
    while (historico.length > 100) historico.pop();
    localStorage.setItem("gw_historico", JSON.stringify(historico));
}


// ── 8. TICK GLOBAL ────────────────────────────────────────────

function iniciarTick() {
    if (tickGlobal) return;
    tickGlobal = setInterval(() => {
        aplicarControleDemanda();
        for (const s of sessoes.values()) {
            if (!isAtiva(s)) continue;
            const kwhTick = s.potenciaAtual / 3600;
            s.bateriaAtual        = Math.min(s.bateriaAtual + (kwhTick / s.capacidadeKwh) * 100, s.bateriaDesejada);
            s.energiaEntregueKwh += kwhTick;
            s.custoTotal          = s.energiaEntregueKwh * s.tarifaKwh;
            s.tempoSegundos++;
            if (++s.tickMeter >= 30) { ocppMeter(s); s.tickMeter = 0; }
            if (s.bateriaAtual >= s.bateriaDesejada) {
                s.bateriaAtual = s.bateriaDesejada;
                encerrarSessao(s);
                logEvento("ok", `Sessão ${s.id} concluída automaticamente`);
            }
        }
        renderizarTudo();
    }, CONFIG.TICK_MS);
}


// ── 9. RENDERIZAÇÃO ───────────────────────────────────────────

function renderizarTudo() {
    // KPIs
    const ativas     = [...sessoes.values()];
    const potTotal   = calcularPotenciaTotal();
    const energia    = ativas.reduce((a, s) => a + s.energiaEntregueKwh, 0);
    const receita    = ativas.reduce((a, s) => a + s.custoTotal, 0)
                     + historico.reduce((a, s) => a + parseFloat(s.custo.replace("R$ ", "")), 0);

    setText("kpi-sessoes-ativas",     ativas.length);
    setText("kpi-potencia-uso",       potTotal.toFixed(1) + " kW");
    setText("kpi-energia-total",      energia.toFixed(1).replace(".", ",") + " kWh");
    setText("kpi-receita",            "R$ " + receita.toFixed(2).replace(".", ","));
    setText("potencia-total-display", potTotal.toFixed(1) + " kW");
    setText("badge-sessoes",          sessoes.size);

    // Barra de demanda
    const pct  = Math.min((potTotal / CONFIG.LIMITE_KW) * 100, 100);
    const fill = el("barra-demanda-fill");
    if (fill) {
        fill.style.width      = pct + "%";
        fill.style.background = pct > 95 ? "linear-gradient(90deg,#ef4444,#f87171)"
                              : pct > 80 ? "linear-gradient(90deg,#f59e0b,#fbbf24)"
                                         : "linear-gradient(90deg,#22c55e,#4ade80)";
    }
    setText("demanda-uso",    potTotal.toFixed(1) + " kW");
    setText("demanda-limite", CONFIG.LIMITE_KW + " kW");

    // Dashboard — lista mini
    const dashEl = el("dashboard-sessoes-lista");
    if (dashEl) {
        dashEl.innerHTML = ativas.length === 0
            ? `<div class="empty-state"><i data-lucide="plug-zap"></i><p>Nenhuma sessão ativa. Clique em <strong>+</strong> para iniciar.</p></div>`
            : ativas.map(s => `
                <div class="sessao-mini">
                    <span class="sessao-mini-id">${s.id} · ${s.veiculo}</span>
                    <div class="sessao-mini-barra-wrap">
                        <div class="sessao-mini-barra"><div class="sessao-mini-barra-fill" style="width:${s.bateriaAtual.toFixed(0)}%"></div></div>
                        <span class="sessao-mini-pct">${s.bateriaAtual.toFixed(0)}%</span>
                    </div>
                    <div class="sessao-mini-info">
                        <span class="tag-potencia">${s.potenciaAtual.toFixed(1)} kW</span>
                        <span class="tag-tarifa ${s.faixaTarifa}">${s.faixaLabel}</span>
                        <span>R$ ${s.custoTotal.toFixed(2)}</span>
                    </div>
                </div>`).join("");
    }

    // Grid de sessões
    const BADGE = {
        carregando: `<span class="sessao-status-badge badge-carregando"><span class="dot dot-green"></span>Carregando</span>`,
        pausado:    `<span class="sessao-status-badge badge-pausado"><span class="dot dot-yellow"></span>Pausado</span>`,
        throttled:  `<span class="sessao-status-badge badge-throttled"><span class="dot dot-red"></span>Throttled</span>`,
    };

    const grid = el("sessoes-grid");
    if (grid) {
        grid.innerHTML = ativas.length === 0
            ? `<div class="empty-state" style="grid-column:1/-1"><i data-lucide="plug-zap"></i><p>Nenhuma sessão ativa.</p></div>`
            : ativas.map(s => `
                <div class="sessao-card">
                    <div class="sessao-card-header">
                        <div>
                            <div class="sessao-card-id">${s.id} · ${s.veiculo}</div>
                            <div class="sessao-card-tipo">${TIPO_LABEL[s.tipo]} · ${s.faixaLabel} · ${s.origemEnergia === "fotovoltaica" ? "☀️ Fotovoltaica" : "⚡ Rede"}</div>
                        </div>
                        ${BADGE[s.status] || `<span class="sessao-status-badge badge-concluido">Concluído</span>`}
                    </div>
                    <div class="sessao-bateria-display">
                        <span class="sessao-bateria-pct">${s.bateriaAtual.toFixed(0)}%</span>
                        <span class="sessao-bateria-meta">→ ${s.bateriaDesejada}%</span>
                    </div>
                    <div class="sessao-barra"><div class="sessao-barra-fill" style="width:${s.bateriaAtual.toFixed(1)}%"></div></div>
                    <div class="sessao-metricas">
                        <div class="sessao-metrica"><span>Energia entregue</span><strong>${s.energiaEntregueKwh.toFixed(2)} kWh</strong></div>
                        <div class="sessao-metrica"><span>Custo estimado</span><strong>R$ ${s.custoTotal.toFixed(2)}</strong></div>
                        <div class="sessao-metrica"><span>Potência</span><strong>${s.potenciaAtual.toFixed(1)} kW</strong></div>
                        <div class="sessao-metrica"><span>Tempo</span><strong>${formatarTempo(s.tempoSegundos)}</strong></div>
                    </div>
                    <div class="sessao-card-acoes">
                        <button class="btn-sm" onclick="togglePausarSessao('${s.id}')">
                            <i data-lucide="${s.status === 'pausado' ? 'play' : 'pause'}"></i>${s.status === "pausado" ? "Retomar" : "Pausar"}
                        </button>
                        <button class="btn-danger" onclick="finalizarSessao('${s.id}')">
                            <i data-lucide="square"></i>Finalizar
                        </button>
                    </div>
                </div>`).join("");
    }

    // Distribuição de potência
    const distEl = el("distribuicao-lista");
    if (distEl) {
        const ativasFiltro = ativas.filter(isAtiva);
        distEl.innerHTML = ativasFiltro.length === 0
            ? `<p class="muted">Sem sessões ativas.</p>`
            : ativasFiltro.map(s => {
                const p = (s.potenciaAtual / CONFIG.LIMITE_KW) * 100;
                return `<div class="dist-item">
                    <span class="dist-id">${s.id}</span>
                    <div class="dist-barra-wrap"><div class="dist-barra"><div class="dist-barra-fill" style="width:${p.toFixed(1)}%"></div></div></div>
                    <span class="dist-kw">${s.potenciaAtual.toFixed(1)} kW</span>
                </div>`;
              }).join("");
    }

    lucide.createIcons();
}

function renderEventosDemanda() {
    const container = el("eventos-demanda");
    if (!container) return;
    container.innerHTML = eventosDemanda.length === 0
        ? `<p class="muted">Nenhum evento registrado.</p>`
        : eventosDemanda.map(ev => `
            <div class="log-entry">
                <span class="log-time">${ev.hora}</span>
                <span class="log-nivel ${ev.nivel}">${ev.nivel.toUpperCase()}</span>
                <span>${ev.msg}</span>
            </div>`).join("");
}

function renderizarRelatorios() {
    const container = el("relatorio-conteudo");
    if (!container) return;
    if (!historico.length) { container.innerHTML = `<p class="muted">Nenhuma sessão finalizada ainda.</p>`; return; }

    let totalKwh = 0, totalCusto = 0;
    for (const s of historico) {
        totalKwh   += parseFloat(s.energiaKwh);
        totalCusto += parseFloat(s.custo.replace("R$ ", ""));
    }

    // while para calcular média (mantém estrutura de repetição explícita)
    let i = 0, somaKwh = 0;
    while (i < historico.length) { somaKwh += parseFloat(historico[i++].energiaKwh); }
    const mediaTarifa = somaKwh > 0 ? totalCusto / somaKwh : 0;

    container.innerHTML = `
        <div class="relatorio-resumo-grid">
            <div class="rel-stat"><span>Sessões finalizadas</span><strong>${historico.length}</strong></div>
            <div class="rel-stat"><span>Energia total entregue</span><strong>${totalKwh.toFixed(1)} kWh</strong></div>
            <div class="rel-stat"><span>Receita total</span><strong>R$ ${totalCusto.toFixed(2)}</strong></div>
            <div class="rel-stat"><span>Tarifa média</span><strong>R$ ${mediaTarifa.toFixed(2)}/kWh</strong></div>
        </div>
        <div class="relatorio-tabela-wrap">
            <h3>Histórico de sessões</h3>
            <div style="overflow-x:auto"><table>
                <thead><tr>
                    <th>ID</th><th>Veículo</th><th>Usuário</th><th>Bateria</th>
                    <th>Energia</th><th>Faixa</th><th>Tarifa</th><th>Custo</th><th>Tempo</th><th>Data</th>
                </tr></thead>
                <tbody>${historico.map(s => `
                    <tr>
                        <td class="td-mono">${s.id}</td><td>${s.veiculo}</td><td>${s.tipo}</td>
                        <td>${s.bateriaInicial} → ${s.bateriaFinal}</td><td>${s.energiaKwh} kWh</td>
                        <td>${s.faixa}</td><td>${s.tarifa}</td><td><strong>${s.custo}</strong></td>
                        <td>${s.tempo}</td><td>${s.data}</td>
                    </tr>`).join("")}
                </tbody>
            </table></div>
        </div>`;
}

function renderizarRegras() {
    setHTML("regras-lista", REGRAS_CONFIG.map((r, i) => `
        <div class="regra-item">
            <span class="regra-num">${i + 1}</span>
            <div><strong>${r.t}</strong><p>${r.d()}</p></div>
        </div>`).join(""));
}


// ── 10. NAVEGAÇÃO ─────────────────────────────────────────────

function navegarPara(viewId) {
    for (const e of document.querySelectorAll(".view, .nav-item")) e.classList.remove("active");
    el(`view-${viewId}`)?.classList.add("active");
    document.querySelector(`.nav-item[data-view="${viewId}"]`)?.classList.add("active");
    const info = VIEWS_INFO[viewId] || {};
    setText("view-title",    info.title    || "");
    setText("view-subtitle", info.subtitle || "");
    if (viewId === "relatorios") renderizarRelatorios();
    if (viewId === "energia")    renderEventosDemanda();
    lucide.createIcons();
}

for (const btn of document.querySelectorAll("[data-view]"))
    btn.addEventListener("click", () => navegarPara(btn.dataset.view));


// ── 11. MODAL ─────────────────────────────────────────────────

const abrirModal  = () => { el("modal-overlay").classList.add("open"); el("modal-erro").style.display = "none"; lucide.createIcons(); };
const fecharModal = () => el("modal-overlay").classList.remove("open");

el("btn-nova-sessao") ?.addEventListener("click", abrirModal);
el("btn-nova-sessao-2")?.addEventListener("click", abrirModal);
el("btn-fechar-modal") ?.addEventListener("click", fecharModal);
el("btn-cancelar-modal")?.addEventListener("click", fecharModal);
el("modal-overlay").addEventListener("click", e => { if (e.target === el("modal-overlay")) fecharModal(); });

el("btn-confirmar-sessao").addEventListener("click", () => {
    const ids    = ["m-veiculo","m-tipo","m-capacidade","m-inicial","m-desejada","m-energia","m-potencia"];
    const [veiculo, tipo, capacidade, inicial, desejada, energia, potencia] = ids.map(id => el(id).value);
    const resultado = criarSessao({ veiculo: veiculo.trim(), tipo, capacidade: +capacidade, inicial: +inicial, desejada: +desejada, energia, potencia: +potencia });
    if (!resultado.ok) { const e = el("modal-erro"); e.textContent = resultado.erros.join(" • "); e.style.display = "block"; return; }
    fecharModal();
    navegarPara("sessoes");
    lucide.createIcons();
});


// ── 12. OUTROS BOTÕES ─────────────────────────────────────────

el("btn-limpar-ocpp")?.addEventListener("click", () => {
    const log = el("ocpp-log");
    if (log) { log.innerHTML = ""; ocppMsgCount = 0; setText("badge-ocpp", "0"); ocpp("system", "Log limpo pelo operador."); }
});

el("btn-gerar-relatorio")?.addEventListener("click", renderizarRelatorios);

el("btn-limpar-historico")?.addEventListener("click", () => {
    historico.length = 0;
    localStorage.removeItem("gw_historico");
    renderizarRelatorios();
});


// ── 13. INICIALIZAÇÃO ─────────────────────────────────────────

renderizarRegras();
renderizarTudo();
ocpp("system", `GOODWE EMS iniciado. Limite: ${CONFIG.LIMITE_KW} kW | Tarifa base: R$ ${CONFIG.TARIFA_BASE}/kWh | Max sessões: ${CONFIG.MAX_SESSOES}`);
lucide.createIcons();