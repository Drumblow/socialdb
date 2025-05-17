import { EventBus } from '../../src/event-bus/EventBus.js';

async function runTests() {
  console.log("--- Iniciando testes para EventBus ---");
  let testsPassed = 0;
  let testsFailed = 0;

  function test(description, testFn) {
    console.log(`
[TEST] ${description}`);
    try {
      testFn();
      console.log("  Status: PASSOU");
      testsPassed++;
    } catch (error) {
      console.error("  Status: FALHOU");
      console.error("    Erro:", error.message);
      if (error.stack) console.error("    Stack:", error.stack.split('\n').slice(1).join('\n'));
      testsFailed++;
    }
  }

  // Mock console.error para testes específicos
  const originalConsoleError = console.error;
  let consoleErrorOutput = [];
  const mockConsoleError = (...args) => {
    consoleErrorOutput.push(args.join(' '));
  };
  const resetConsoleErrorMock = () => {
    console.error = originalConsoleError;
    consoleErrorOutput = [];
  };
  const expectConsoleErrorToHaveBeenCalledWith = (expectedSubstring) => {
    console.assert(consoleErrorOutput.some(output => output.includes(expectedSubstring)), `Expected console.error to have been called with substring: "${expectedSubstring}", but got: [${consoleErrorOutput.join(', ')}]`);
  }

  test("Deve registrar e emitir um evento para um único listener", () => {
    const eventBus = new EventBus();
    let listenerCalled = false;
    let receivedData = null;
    const callback = (data) => {
      listenerCalled = true;
      receivedData = data;
    };

    eventBus.on('testEvent', callback);
    eventBus.emit('testEvent', 'testData');

    console.assert(listenerCalled, "Listener não foi chamado.");
    console.assert(receivedData === 'testData', `Dados recebidos incorretos: ${receivedData}`);
    console.assert(eventBus.listenerCount('testEvent') === 1, "Contagem de listeners incorreta");
  });

  test("Deve registrar e emitir um evento para múltiplos listeners", () => {
    const eventBus = new EventBus();
    let listener1Called = false;
    let listener2Called = false;

    eventBus.on('multiEvent', () => { listener1Called = true; });
    eventBus.on('multiEvent', () => { listener2Called = true; });
    eventBus.emit('multiEvent');

    console.assert(listener1Called, "Listener 1 não foi chamado.");
    console.assert(listener2Called, "Listener 2 não foi chamado.");
    console.assert(eventBus.listenerCount('multiEvent') === 2, "Contagem de listeners incorreta");
  });

  test("Deve permitir remover um listener específico com off()", () => {
    const eventBus = new EventBus();
    let listenerCalled = false;
    const callback = () => { listenerCalled = true; };

    eventBus.on('offEvent', callback);
    eventBus.off('offEvent', callback);
    eventBus.emit('offEvent');

    console.assert(!listenerCalled, "Listener foi chamado após ser removido.");
    console.assert(eventBus.listenerCount('offEvent') === 0, "Contagem de listeners incorreta após off()");
  });

  test("Não deve falhar ao tentar remover um listener de um evento inexistente", () => {
    const eventBus = new EventBus();
    const callback = () => {};
    console.assert(eventBus.listenerCount('nonExistentEvent') === 0, "Contagem inicial deve ser 0");
    eventBus.off('nonExistentEvent', callback); // Não deve lançar erro
    console.assert(eventBus.listenerCount('nonExistentEvent') === 0, "Contagem deve permanecer 0");
    eventBus.emit('nonExistentEvent'); // Não deve lançar erro
  });

  test("Deve chamar múltiplos listeners com os dados corretos", () => {
    const eventBus = new EventBus();
    let data1 = null, data2 = null;

    eventBus.on('dataCheck', (d) => { data1 = d; });
    eventBus.on('dataCheck', (d) => { data2 = d; });
    eventBus.emit('dataCheck', 'payload');

    console.assert(data1 === 'payload', `Listener 1 recebeu dados incorretos: ${data1}`);
    console.assert(data2 === 'payload', `Listener 2 recebeu dados incorretos: ${data2}`);
  });

  test("Deve permitir remover todos os listeners de um evento específico com removeAllListeners(eventName)", () => {
    const eventBus = new EventBus();
    let called1 = false, called2 = false;
    eventBus.on('removeAllSpecific', () => { called1 = true; });
    eventBus.on('removeAllSpecific', () => { called2 = true; });
    console.assert(eventBus.listenerCount('removeAllSpecific') === 2, "Contagem inicial incorreta");
    eventBus.removeAllListeners('removeAllSpecific');
    eventBus.emit('removeAllSpecific');
    console.assert(!called1 && !called2, "Listeners foram chamados após removeAllListeners(eventName).");
    console.assert(eventBus.listenerCount('removeAllSpecific') === 0, "Contagem de listeners incorreta após removeAllListeners(eventName)");
  });

  test("Deve permitir remover todos os listeners de todos os eventos com removeAllListeners()", () => {
    const eventBus = new EventBus();
    let called1 = false, called2 = false;
    eventBus.on('eventA', () => { called1 = true; });
    eventBus.on('eventB', () => { called2 = true; });
    console.assert(eventBus.listenerCount('eventA') === 1, "Contagem inicial A incorreta");
    console.assert(eventBus.listenerCount('eventB') === 1, "Contagem inicial B incorreta");
    eventBus.removeAllListeners();
    eventBus.emit('eventA');
    eventBus.emit('eventB');
    console.assert(!called1 && !called2, "Listeners foram chamados após removeAllListeners().");
    console.assert(eventBus.listenerCount('eventA') === 0, "Contagem de listeners A incorreta após removeAllListeners()");
    console.assert(eventBus.listenerCount('eventB') === 0, "Contagem de listeners B incorreta após removeAllListeners()");
  });

  test("Deve capturar e logar erros dentro de um listener sem parar outros listeners", () => {
    const eventBus = new EventBus();
    let listenerOkCalled = false;
    console.error = mockConsoleError; // Mock console.error

    eventBus.on('errorEvent', () => {
      throw new Error('Simulated error in listener');
    });
    eventBus.on('errorEvent', () => {
      listenerOkCalled = true;
    });
    eventBus.emit('errorEvent');

    expectConsoleErrorToHaveBeenCalledWith('EventBus: Erro no listener para o evento "errorEvent": Simulated error in listener');
    console.assert(listenerOkCalled, "Listener subsequente não foi chamado após erro no anterior.");
    
    resetConsoleErrorMock();
  });

  test("Não deve registrar um callback que não seja uma função", () => {
    const eventBus = new EventBus();
    console.error = mockConsoleError; // Mock console.error
    
    eventBus.on('invalidCallbackEvent', null);
    eventBus.on('invalidCallbackEvent', 'não sou uma função');
    
    expectConsoleErrorToHaveBeenCalledWith('EventBus: Tentativa de registrar um callback não-função para o evento "invalidCallbackEvent".');
    console.assert(eventBus.listenerCount('invalidCallbackEvent') === 0, "Callback inválido foi registrado.");
    
    resetConsoleErrorMock();
  });

  console.log(`
--- Resultados dos Testes ---`);
  console.log(`  Testes Passados: ${testsPassed}`);
  console.log(`  Testes Falhados: ${testsFailed}`);
  if (testsFailed === 0) {
    console.log("  TODOS OS TESTES PASSARAM! ✅");
    process.exitCode = 0;
  } else {
    console.error("  ALGUNS TESTES FALHARAM! ❌");
    process.exitCode = 1;
  }
}

runTests(); 