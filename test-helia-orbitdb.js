import { createHelia } from 'helia';
import { createOrbitDB } from '@orbitdb/core';
import { registerFeed } from '@orbitdb/feed-db';
import { createLibp2p } from 'libp2p';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { webSockets } from '@libp2p/websockets';

async function main() {
  console.log('Iniciando teste Helia e OrbitDB...');

  let libp2pNode;
  let heliaNode;
  let orbitdbInstance;
  let db;

  try {
    // 0. Criar instância Libp2p configurada
    console.log('Criando nó Libp2p configurado...');
    const libp2pOptions = {
      addresses: {
        listen: [
          '/ip4/0.0.0.0/tcp/0/ws'
        ]
      },
      transports: [
        webSockets()
      ],
      connectionEncryption: [
        noise()
      ],
      streamMuxers: [
        yamux()
      ],
      services: {
        pubsub: gossipsub({
          allowPublishToZeroTopicPeers: true
        }),
        identify: identify()
      }
    };
    libp2pNode = await createLibp2p(libp2pOptions);
    console.log('Nó Libp2p criado. Peer ID:', libp2pNode.peerId.toString());

    // 1. Iniciar Helia com a instância libp2p configurada
    console.log('Criando nó Helia com Libp2p customizado...');
    heliaNode = await createHelia({ libp2p: libp2pNode });
    console.log('Nó Helia criado.');

    // Registrar o tipo de banco de dados Feed ANTES de criar a instância OrbitDB
    console.log('Registrando tipo de banco de dados Feed...');
    registerFeed();

    // 2. Criar instância OrbitDB usando createOrbitDB
    console.log('Criando instância OrbitDB (usando createOrbitDB)...');
    orbitdbInstance = await createOrbitDB({ ipfs: heliaNode });
    console.log('Instância OrbitDB criada. ID:', orbitdbInstance.id);

    // 3. Abrir um banco de dados (Feed)
    const dbName = '/orbitdb/test-feed-database/social-posts';
    console.log(`Abrindo/Criando banco de dados Feed: ${dbName}`);
    // Usar o tipo string "feed" após o registro
    db = await orbitdbInstance.open(dbName, { 
        type: "feed" 
    });
    console.log(`Banco de dados Feed aberto. Endereço: ${db.address}`);

    // 4. Adicionar uma entrada
    const entryData = {
      timestamp: new Date().toISOString(),
      author: heliaNode.libp2p.peerId.toString(),
      text: 'Olá do OrbitDB e Helia!'
    };
    console.log('Adicionando entrada ao feed:', entryData);
    const hash = await db.add(entryData);
    console.log('Entrada adicionada ao feed. Hash:', hash);

    // Aguardar um pouco para a propagação/escrita interna
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 5. Ler entradas
    console.log('Lendo todas as entradas do feed...');
    const allEntries = await db.all();
    if (allEntries.length > 0) {
      allEntries.forEach(entry => {
        console.log('  - Estrutura completa da entrada:', entry); // Log para depuração
        console.log('  - Valor da entrada:', entry.value); // Corrigido: Acessar entry.value diretamente
      });
    } else {
      console.log('Nenhuma entrada encontrada no feed.');
    }

    console.log('Teste concluído com sucesso!');

  } catch (error) {
    console.error('Erro durante o teste Helia/OrbitDB:', error);
  } finally {
    // 6. Parar OrbitDB e Helia
    if (db) {
      console.log('Fechando banco de dados...');
      await db.close();
    }
    if (orbitdbInstance) {
      console.log('Parando OrbitDB...');
      await orbitdbInstance.stop();
    }
    if (heliaNode) {
      console.log('Parando nó Helia...');
      await heliaNode.stop();
    }
    console.log('Recursos limpos.');
  }
}

main(); 