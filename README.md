# GOODWE — Sistema Inteligente de Gerenciamento de Recarga
**Sprint 2 — DSA**

---

## Descrição

Sistema web para gerenciamento simultâneo de múltiplas sessões de recarga de veículos elétricos. O sistema controla a distribuição de potência entre os carregadores, aplica tarifação dinâmica por horário e simula a comunicação com uma plataforma central usando o protocolo OCPP 1.6.

---

## Como Executar

1. Extraia os arquivos do projeto
2. Abra `index.html` diretamente no navegador (Chrome, Firefox ou Edge)
3. Nenhuma instalação ou servidor necessário

> Para testar múltiplos cenários rapidamente, abra o modal com o botão **+** e crie 3 ou mais sessões com potências diferentes.

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

## Funcionalidades

### Menu interativo (5 seções)

| Seção | Função |
|---|---|
| Dashboard | KPIs em tempo real, barra de demanda, lista de sessões ativas |
| Sessões | Cards individuais de cada sessão com controles de pausa/finalização |
| Energia | Regras de controle de potência, distribuição por carregador, log de eventos |
| OCPP Log | Log completo de mensagens do protocolo de comunicação |
| Relatórios | Tabela histórica com totais e médias calculadas |

---

## Lógica do Sistema

### 1. Gerenciamento de múltiplas sessões

O sistema usa um `Map` JavaScript como estrutura de dados principal. Cada sessão recebe um ID único (`CP-01`, `CP-02`, ...) e é armazenada como um objeto com todos os seus dados:

```js
const sessoes = new Map();

// Cada sessão contém:
{
    id, veiculo, tipo, capacidadeKwh,
    bateriaAtual, bateriaDesejada,
    potenciaAtual, potenciaOriginal,
    energiaEntregueKwh, custoTotal,
    tempoSegundos, status, ...
}
```

Um único `setInterval` (tick global) atualiza todas as sessões a cada segundo, usando `for...of` no Map:

```js
for (const sessao of sessoes.values()) {
    if (sessao.status !== "carregando") continue;
    // atualiza bateria, energia, custo...
}
```

Isso evita múltiplos timers paralelos e garante sincronização entre sessões.

---

### 2. Controle inteligente de demanda

A função `aplicarControleDemanda()` é chamada a cada tick e implementa três estados:

**Estado normal** (< 80% do limite):
- Todas as sessões rodam na potência contratada

**Estado de atenção** (80–95%):
- Sistema registra evento de alerta no log
- Nenhuma redução de potência ainda

**Estado crítico** (> 95%) — Throttling automático:
- A potência disponível (90% do limite) é dividida igualmente entre todas as sessões ativas
- Cada sessão passa para o status `"throttled"`
- Mensagem OCPP `ChangeAvailability` é enviada à central
- Quando a demanda cai abaixo de 80%, a potência original é restaurada automaticamente

```js
// Throttling com for...of
const potenciaPorSessao = (CONFIG.LIMITE_POTENCIA_KW * 0.90) / ativas.length;

for (const sessao of ativas) {
    if (sessao.potenciaAtual > potenciaPorSessao) {
        sessao.potenciaAtual = potenciaPorSessao;
        sessao.status = "throttled";
    }
}
```

---

### 3. Tarifação dinâmica

A tarifa é calculada ao criar cada sessão, combinando três fatores:

#### Faixas horárias

```js
const FAIXAS_HORARIAS = [
    { nome: "pico",    horas: [6,7,8,17,18,19,20],     mult: 1.50 },  // +50%
    { nome: "noturno", horas: [21,22,23,0,1,2,3,4,5],  mult: 0.80 },  // -20%
    { nome: "normal",  horas: [],                       mult: 1.00 },  // base
];
```

A busca pela faixa usa `for...of` duplo:

```js
for (const faixa of FAIXAS_HORARIAS) {
    for (const h of faixa.horas) {
        if (h === hora) return faixa;
    }
}
```

#### Descontos por tipo de usuário

| Tipo | Desconto |
|---|---|
| Comum | 0% |
| Assinante GOODWE+ | 15% |
| Corporativo | 10% |

#### Desconto por origem da energia

| Origem | Desconto |
|---|---|
| Rede elétrica | 0% |
| Fotovoltaica | 5% |

#### Fórmula completa

```
Tarifa com pico  = R$ 1,80 × multiplicador_horário
Desconto total   = desconto_usuário + desconto_energia
Tarifa efetiva   = Tarifa com pico × (1 − desconto_total)
Custo da sessão  = kWh entregues × Tarifa efetiva
```

---

### 4. Simulação OCPP 1.6

O sistema simula o protocolo OCPP (Open Charge Point Protocol) versão 1.6, que é o padrão real de comunicação entre carregadores e plataformas de gestão.

As mensagens seguem o formato de array JSON do protocolo:
```
[TipoMensagem, UniqueId, Ação, Payload]
```

#### Fluxo de mensagens por sessão

| Evento | Mensagens simuladas |
|---|---|
| Conexão | `BootNotification` (CP→CS) + resposta (CS→CP) |
| Início | `StartTransaction` (CP→CS) + resposta com transactionId |
| Em carga | `StatusNotification` com status "Charging" |
| A cada 30s | `MeterValues` com energia (kWh) e potência (kW) |
| Throttling | `ChangeAvailability` (CS→CP) com type "Inoperative" |
| Restauração | `ChangeAvailability` (CS→CP) com type "Operative" |
| Fim | `StopTransaction` com meterStop e reason |

Exemplo de mensagem gerada pelo sistema:
```json
[2,"A3F8B2C1","StartTransaction",{
  "connectorId": 1,
  "idTag": "CP-03",
  "meterStart": 0,
  "timestamp": "2026-06-11T19:30:00.000Z"
}]
```

---

### 5. Estruturas de dados e algoritmos utilizados

#### Map (sessões ativas)
```js
const sessoes = new Map();
sessoes.set(id, sessao);   // O(1)
sessoes.get(id);            // O(1)
sessoes.delete(id);         // O(1)
```

#### Array (histórico e eventos)
```js
historico.unshift(sessao);  // insere no início
while (historico.length > 100) historico.pop(); // limita tamanho
```

#### for...of (iteração principal)
Usado em: validação de campos, renderização de sessões, cálculo de totais, busca de faixa tarifária, throttling, relatórios.

#### while (controle de limites e animação)
Usado em: limite do histórico, limite de eventos de demanda, construção de strings.

#### switch (estados visuais)
Usado em: cor da barra de demanda, badge de status de sessão, label de tipo de usuário.

---

### 6. Cálculo de energia por tick

A simulação é baseada em física real:

```
Energia por tick (kWh) = Potência (kW) × (1 segundo / 3600 segundos)
% por tick             = (Energia tick / Capacidade total kWh) × 100
```

Com um carregador de 22 kW e bateria de 60 kWh:
```
Energia/tick = 22 / 3600 ≈ 0,00611 kWh
% por tick   = (0,00611 / 60) × 100 ≈ 0,0102% por segundo
```

Na simulação acelerada, a progressão visual usa `PASSO_BATERIA_PCT = 2%` para demonstração interativa.

---

### 7. Persistência de dados

| Mecanismo | Uso |
|---|---|
| `Map` (memória) | Sessões ativas — perdidas ao fechar o navegador |
| `localStorage` | Histórico de sessões finalizadas — persiste entre visitas |

---

## Cenários de teste sugeridos

**Cenário 1 — Throttling automático**
1. Crie 3 sessões com carregadores de 50 kW cada (total: 150 kW = 100% do limite)
2. Observe a barra de demanda ficar vermelha
3. O sistema reduz a potência de cada um para ~45 kW automaticamente
4. Finalize uma sessão e veja a potência ser restaurada

**Cenário 2 — Tarifação dinâmica**
1. Crie uma sessão às 18h (horário de pico) com usuário Assinante e energia fotovoltaica
2. Tarifa: R$1,80 × 1,50 × (1 − 0,20) = R$2,16/kWh
3. Compare com uma sessão noturna comum: R$1,80 × 0,80 = R$1,44/kWh

**Cenário 3 — Múltiplas sessões**
1. Crie 5 sessões simultaneamente com veículos diferentes
2. Pause algumas e observe o controle de demanda se ajustar
3. Exporte o relatório para comparar custos por faixa tarifária

---

## Tecnologias

- **HTML5** — estrutura semântica e acessível
- **CSS3** — Grid, variáveis CSS, responsividade
- **JavaScript ES6+** — Map, for...of, destructuring, template literals, optional chaining
- **Lucide Icons** — ícones via CDN
- **Google Fonts** — Inter + JetBrains Mono

---