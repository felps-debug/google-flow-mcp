# Google Flow MCP — Conexão usável

## Objetivo

Tornar a conexão de contas do Google Flow operável no dia a dia: conectar uma conta nova, reconectar uma sessão expirada, escolher entre várias contas e descobrir por que uma conta deixou de funcionar sem precisar iniciar uma geração.

## Problemas observados

- O login bridge mantém `connectionId`, prazo e sessão recebida apenas em memória.
- A extensão varre dez portas e mostra apenas um estado genérico; não identifica claramente qual solicitação deve receber a sessão.
- O fluxo exige clicar na extensão, esperar “Session sent”, responder ao agente e depois escolher a conta em outra janela.
- `connectionStatus` só é corrigido quando uma operação usa o navegador; uma conta pode aparecer como conectada mesmo estando expirada.
- Não existe uma operação explícita para selecionar a conta padrão.
- Erros de sessão, acesso indisponível, navegador morto e Flow fora do workspace ficam misturados ou só aparecem no próximo erro.

## Resultado esperado

1. Cada solicitação de conexão tem estado persistente, prazo, conta-alvo e motivo do último erro.
2. O bridge e a extensão mostram a solicitação correta, com conta-alvo e ação clara.
3. Reconectar uma conta existente preserva seu ID e rótulo; não cria `flow-account-2` por acidente.
4. É possível selecionar explicitamente a conta padrão.
5. É possível verificar uma conta ou todas as contas sem gastar créditos, recebendo diagnóstico estruturado.
6. Operações de geração continuam exigindo conta conectada e opções reais do Flow.

## Não objetivos

- Automatizar login, CAPTCHA ou contornar políticas do Google.
- Copiar cookies para fora da máquina ou criar uma API oficial inexistente do Flow.
- Refatorar os seletores de geração já alterados no working tree.

## Direção técnica

Adicionar um pequeno “connection control plane” ao `FlowStore`, fazer o `CookieBridge` trabalhar com o pedido persistido e expor ferramentas MCP para reconectar, selecionar conta e diagnosticar saúde. A extensão continua sendo o ponto explícito de transferência da sessão, mas passa a mostrar o alvo e o estado da solicitação.

As mudanças serão entregues em fases independentes:

1. Modelo persistente de conexão, estados e mensagens de erro.
2. Onboarding/reconexão idempotente e extensão orientada por solicitação.
3. Seleção de conta e diagnóstico de saúde.

Cada fase terá testes unitários e de contrato MCP antes de alterar o comportamento seguinte.
