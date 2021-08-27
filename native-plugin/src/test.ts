const dylib = Deno.dlopen('./kubernetes_client.so', {
  "Init": { parameters: [], result: "u64" },
  "Submit": { parameters: ["u64", "u64"], result: "u64" },
});

const clientsetId = dylib.symbols.Init();
console.log('Got ID:', clientsetId);

console.log('Submit:', dylib.symbols.Submit(clientsetId, 13));

dylib.close();
