# GOODWE — Sistema Inteligente de Gerenciamento de Recarga
**Sprint 2 — DSA**

---

## Descrição

Sistema web para gerenciamento simultâneo de múltiplas sessões de recarga de veículos elétricos. Controla a distribuição de potência entre os carregadores, aplica tarifação dinâmica por horário e simula a comunicação com uma plataforma central usando o protocolo OCPP 1.6.

---

## Como Executar

1. Extraia os arquivos do projeto
2. Abra `index.html` diretamente no navegador (Chrome, Firefox ou Edge)
3. Nenhuma instalação ou servidor necessário

---

## Estrutura de Arquivos

```
/
├── index.html    ← Interface completa (menu, views, modal)
├── style.css     ← Estilos do sistema
├── sistema.js    ← Toda a lógica do sistema
└── README.md     ← Este documento
```

---

## Menu interativo (5 seções)

| Seção | Função |
|---|---|
| Dashboard | KPIs em tempo real, barra de demanda, lista resumida de sessões |
| Sessões | Cards individuais com controles de pausa e finalização |
| Energia | Regras de potência, distribuição por carregador, log de eventos |
| OCPP Log | Mensagens do protocolo de comunicação em tempo real |
| Relatórios | Tabela histórica com totais e médias calculadas |

---

## Estrutura do Código (`sistema.js`)

O arquivo foi otimizado de **1030 para ~450 linhas**, mantendo toda a funcionalidade. As principais estratégias de otimização foram:

- Constantes de configuração centralizadas em objetos (`CONFIG`, `FAIXAS`, `DESCONTOS`)
- Funções utilitárias compactas com arrow functions (`setText`, `horaAtual`, `formatarTempo`)
- Renderização unificada em `renderizarTudo()` — elimina chamadas redundantes
- HTML das sessões gerado via `.map().join("")` em vez de loops separados
- OCPP `BootNotification` e `StartTransaction` fundidos em `ocppHandshake()`
- Objeto `BADGE` substitui o `switch` de status por lookup direto

---

## Lógica do Sistema

### 1. Configurações globais

Todas as constantes ficam no topo do arquivo para facilitar ajustes:

```js
const CONFIG = {
    LIMITE_KW:   150,   // potência máxima do eletroposto
    ALERTA_PCT:  0.80,  // 80% → alerta de demanda
    CRITICO_PCT: 0.95,  // 95% → throttling automático
    MAX_SESSOES: 8,     // sessões simultâneas máximas
    TARIFA_BASE: 1.80,  // R$/kWh
    TICK_MS:     1000,  // intervalo de simulação (ms)
};
```

---

### 2. Tarifação dinâmica

A tarifa é calculada ao criar cada sessão, combinando três fatores:

#### Faixas horárias

```js
const FAIXAS = [
    { nome: "pico",    label: "Pico (+50%)",   horas: [6,7,8,17,18,19,20],     mult: 1.50 },
    { nome: "noturno", label: "Noturno (−20%)", horas: [21,22,23,0,1,2,3,4,5], mult: 0.80 },
    { nome: "normal",  label: "Normal",          horas: [],                      mult: 1.00 },
];
```

A função `getFaixa(hora)` usa `for...of` duplo para encontrar a faixa correta:

```js
function getFaixa(hora) {
    for (const f of FAIXAS)
        for (const h of f.horas)
            if (h === hora) return f;
    return FAIXAS[2]; // fallback: normal
}
```

#### Descontos por tipo de usuário

| Tipo | Desconto |
|---|---|
| Comum | 0% |
| Assinante GOODWE+ | 15% |
| Corporativo | 10% |

#### Desconto por energia fotovoltaica: 5% adicional

#### Fórmula

```
Tarifa efetiva  = Tarifa base × Multiplicador horário × (1 − Desconto total)
Custo da sessão = kWh entregues × Tarifa efetiva
```

---

### 3. Controle inteligente de demanda

`aplicarControleDemanda()` é chamada a cada tick e opera em três estados:

| Nível | Condição | Ação |
|---|---|---|
| Normal | < 80% do limite | Operação livre |
| Atenção | 80–95% | Evento registrado, sem intervenção |
| Crítico | > 95% | **Throttling**: potência redistribuída igualmente |

```js
// Throttling com for...of
const potPor = (CONFIG.LIMITE_KW * 0.90) / ativas.length;
for (const s of ativas) {
    if (s.potenciaAtual > potPor) {
        s.potenciaAtual = potPor;
        s.status = "throttled";
    }
}
```

Quando a demanda cai abaixo de 80%, a potência original é restaurada automaticamente.

---

### 4. Tick global

Um único `setInterval` atualiza todas as sessões a cada segundo:

```js
// Fórmula física da simulação
const kwhTick = s.potenciaAtual / 3600;               // energia por tick
s.bateriaAtual += (kwhTick / s.capacidadeKwh) * 100;  // % por tick
s.energiaEntregueKwh += kwhTick;
s.custoTotal = s.energiaEntregueKwh * s.tarifaKwh;
```

Ao atingir a bateria desejada, a sessão é encerrada automaticamente, o relatório é salvo e o OCPP `StopTransaction` é enviado.

---

### 5. Simulação OCPP 1.6

Mensagens no formato real do protocolo `[TipoMensagem, UniqueId, Ação, Payload]`:

| Evento | Mensagens simuladas |
|---|---|
| Conexão | `BootNotification` (CP→CS) + resposta (CS→CP) |
| Início | `StartTransaction` + `StatusNotification: Charging` |
| A cada 30s | `MeterValues` com energia (kWh) e potência (kW) |
| Throttling | `ChangeAvailability: Inoperative` (CS→CP) |
| Restauração | `ChangeAvailability: Operative` (CS→CP) |
| Fim | `StopTransaction` com meterStop e reason |

As funções `ocppHandshake()` e `ocppStop()` encapsulam o fluxo completo de cada evento.

---

### 6. Validação de sessões

`criarSessao()` usa `filter` sobre uma lista de regras antes de criar qualquer sessão:

```js
const regras = [
    { ok: () => dados.veiculo?.length >= 2,       msg: "Identificador muito curto." },
    { ok: () => dados.capacidade > 0,              msg: "Capacidade inválida." },
    { ok: () => dados.inicial >= 0,                msg: "Bateria inicial inválida." },
    { ok: () => dados.desejada > dados.inicial,    msg: "Bateria desejada inválida." },
    { ok: () => dados.potencia > 0,                msg: "Potência inválida." },
    { ok: () => sessoes.size < CONFIG.MAX_SESSOES, msg: "Máximo de sessões atingido." },
];

const erros = regras.filter(r => !r.ok()).map(r => r.msg);
```

---

### 7. Renderização

`renderizarTudo()` é a única função de renderização chamada pelo tick — ela atualiza KPIs, barra de demanda, lista do dashboard, grid de sessões e distribuição de potência numa única passagem.

O HTML das sessões é gerado com `.map().join("")`:

```js
grid.innerHTML = ativas.map(s => `<div class="sessao-card">...</div>`).join("");
```

O badge de status usa lookup em objeto em vez de `switch`:

```js
const BADGE = {
    carregando: `<span class="badge-carregando">Carregando</span>`,
    pausado:    `<span class="badge-pausado">Pausado</span>`,
    throttled:  `<span class="badge-throttled">Throttled</span>`,
};
```

---

### 8. Persistência de dados

| Mecanismo | Uso |
|---|---|
| `Map` (memória) | Sessões ativas — limpas ao fechar o navegador |
| `localStorage` | Histórico de sessões finalizadas — persiste entre visitas |

O histórico é limitado a 100 registros com `while`:

```js
while (historico.length > 100) historico.pop();
```

---

## Estruturas de programação utilizadas

### Condicionais

```js
// if/else encadeado — controle de demanda
if (pot > limCritico)      { /* throttling */ }
else if (pot <= limAlerta) { /* restaurar  */ }
else                       { /* alerta     */ }

// Ternário — cor da barra de demanda
fill.style.background = pct > 95 ? "linear-gradient(...vermelho)"
                      : pct > 80 ? "linear-gradient(...amarelo)"
                                 : "linear-gradient(...verde)";
```

### Estruturas de repetição

```js
// for...of duplo — percorre faixas horárias
for (const f of FAIXAS)
    for (const h of f.horas)
        if (h === hora) return f;

// for...of — throttling nas sessões ativas
for (const s of ativas) {
    if (s.potenciaAtual > potPor) { ... }
}

// for...of — tick global atualiza todas as sessões
for (const s of sessoes.values()) { ... }

// while — limita histórico a 100 registros
while (historico.length > 100) historico.pop();

// while — calcula média de tarifa
while (i < historico.length) { somaKwh += parseFloat(historico[i++].energiaKwh); }
```

---

## Cenários de teste sugeridos

**Cenário 1 — Throttling automático**
1. Crie 3 sessões com carregadores de 50 kW cada (total: 150 kW = 100% do limite)
2. Observe a barra de demanda ficar vermelha
3. O sistema reduz a potência automaticamente para ~45 kW por sessão
4. Finalize uma sessão e veja a restauração automática

**Cenário 2 — Tarifação dinâmica**
- Sessão às 18h, Assinante, Fotovoltaica:
  `R$1,80 × 1,50 × (1 − 0,20) = R$2,16/kWh`
- Sessão noturna, Comum, Rede:
  `R$1,80 × 0,80 = R$1,44/kWh`

**Cenário 3 — Múltiplas sessões simultâneas**
1. Crie 5 sessões com veículos e potências diferentes
2. Pause algumas e observe o controle de demanda se ajustar
3. Gere o relatório para comparar custos por faixa tarifária

---

## Tecnologias

- **HTML5** — estrutura semântica
- **CSS3** — Grid, variáveis CSS, responsividade
- **JavaScript ES6+** — Map, for...of, arrow functions, template literals, optional chaining
- **Lucide Icons** — ícones via CDN
- **Google Fonts** — Inter + JetBrains Mono

---
