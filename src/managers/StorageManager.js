import { createHelia } from 'helia';
import { createOrbitDB } from '@orbitdb/core';
import path from 'path';

export class StorageManager {
  constructor(eventBus, identityManager, heliaNodeInstance, orbitDbDirectory) {
    this.eventBus = eventBus; 
    this.identityManager = identityManager;
    this.heliaNode = heliaNodeInstance; 
    this.orbitDbDirectory = orbitDbDirectory;
    this.orbitDB = null;
    this.openedScopedDBs = new Map();
  }

  async init() {
    console.log("STORAGE_MAN: Inicializando StorageManager...");
    try {
      if (!this.heliaNode) {
        console.error("STORAGE_MAN: Instância Helia não foi fornecida ao construtor e é obrigatória.");
        throw new Error("STORAGE_MAN: Instância Helia é obrigatória.");
      }
      console.log("STORAGE_MAN: Nó Helia fornecido e pronto.");

      console.log("STORAGE_MAN: Criando instância OrbitDB...");
      // Garantir que o diretório exista ou que OrbitDB possa criá-lo se necessário.
      // fs.mkdirSync(this.orbitDbDirectory, { recursive: true }); // Opcional, OrbitDB geralmente cria.
      this.orbitDB = await createOrbitDB({ 
        ipfs: this.heliaNode, 
        directory: this.orbitDbDirectory 
      });
      console.log(`STORAGE_MAN: Instância OrbitDB criada. Usando diretório: ${this.orbitDbDirectory}`);
      
      return { heliaNode: this.heliaNode, orbitDB: this.orbitDB };
    } catch (error) {
      console.error(`STORAGE_MAN: Erro ao inicializar OrbitDB (diretório: ${this.orbitDbDirectory}):`, error);
      throw error;
    }
  }

  getHeliaNode() {
    if (!this.heliaNode) {
      throw new Error("STORAGE_MAN: Nó Helia não inicializado. Chame init() primeiro.");
    }
    return this.heliaNode;
  }

  getOrbitDB() {
    if (!this.orbitDB) {
      throw new Error("STORAGE_MAN: OrbitDB não inicializado. Chame init() primeiro.");
    }
    return this.orbitDB;
  }

  /**
   * Abre ou retorna um banco de dados OrbitDB escopado para um addon específico.
   * @param {string} addonId O ID do addon para o qual o DB será escopado.
   * @param {string} dbName O nome desejado para o DB (dentro do escopo do addon).
   * @param {string} [dbType='keyvalue'] O tipo de OrbitDB (ex: 'keyvalue', 'documents', 'events').
   * @param {object} [options={}] Opções adicionais para orbitdb.open().
   * @returns {Promise<OrbitDBStore>} A instância do banco de dados OrbitDB.
   */
  async getScopedOrbitDB(addonId, dbName, dbType = 'keyvalue', options = {}) {
    if (!this.orbitDB) {
      console.error("STORAGE_MAN: OrbitDB não inicializado ao tentar obter DB escopado.");
      throw new Error("STORAGE_MAN: OrbitDB não inicializado. Chame init() primeiro.");
    }
    if (!addonId || typeof addonId !== 'string' || !addonId.trim()) {
      throw new Error("STORAGE_MAN: addonId é obrigatório para getScopedOrbitDB.");
    }
    if (!dbName || typeof dbName !== 'string' || !dbName.trim()) {
      throw new Error("STORAGE_MAN: dbName é obrigatório para getScopedOrbitDB.");
    }

    const scopedDbFullName = `addon--${addonId}--${dbName}`;

    if (this.openedScopedDBs.has(scopedDbFullName)) {
      const cachedDb = this.openedScopedDBs.get(scopedDbFullName);
      // Verificar se o DB não foi fechado externamente (difícil de fazer sem estado explícito no DB)
      // Por agora, apenas retorna o cacheado.
      console.log(`STORAGE_MAN: Retornando DB escopado cacheado: ${scopedDbFullName}`);
      return cachedDb;
    }

    console.log(`STORAGE_MAN: Abrindo novo DB escopado: ${scopedDbFullName} (tipo: ${dbType})`);
    try {
      const dbOpenOptions = {
        type: dbType,
        create: true, // Sempre cria se não existir, pois é escopado
        ...options 
      };
      const dbInstance = await this.orbitDB.open(scopedDbFullName, dbOpenOptions);
      console.log(`STORAGE_MAN: DB escopado '${scopedDbFullName}' aberto. Endereço: ${dbInstance.address.toString()}`);
      
      // Adicionar listeners básicos (semelhante ao ProfileService, mas mais genérico)
      dbInstance.events.on('ready', () => {
        console.log(`STORAGE_MAN_DB_EVENT [${scopedDbFullName}]: DB está PRONTO localmente.`);
      });
      dbInstance.events.on('update', (entry) => {
        console.log(`STORAGE_MAN_DB_EVENT [${scopedDbFullName}]: Recebido 'update'. Entrada:`, entry ? entry.payload : 'N/A');
      });
      dbInstance.events.on('replicated', (address) => {
          console.log(`STORAGE_MAN_DB_EVENT [${scopedDbFullName}]: DB '${address}' foi REPLICADO.`);
      });
      dbInstance.events.on('close', () => {
          console.log(`STORAGE_MAN_DB_EVENT [${scopedDbFullName}]: DB foi fechado.`);
          this.openedScopedDBs.delete(scopedDbFullName); // Remover do cache ao fechar
      });

      this.openedScopedDBs.set(scopedDbFullName, dbInstance);
      return dbInstance;
    } catch (error) {
      console.error(`STORAGE_MAN: Falha ao abrir DB escopado '${scopedDbFullName}':`, error);
      throw error;
    }
  }

  async close() {
    console.log("STORAGE_MAN: Fechando StorageManager...");
    // Fechar todos os DBs escopados abertos
    if (this.openedScopedDBs.size > 0) {
      console.log(`STORAGE_MAN: Fechando ${this.openedScopedDBs.size} DBs escopados abertos...`);
      for (const [name, db] of this.openedScopedDBs) {
        try {
          if (db && (typeof db.close === 'function') && (db.status !== 'closed' && !db.closed)) { // Checagem mais robusta
            await db.close();
            console.log(`STORAGE_MAN: DB escopado '${name}' fechado.`);
          } else if (db && (db.status === 'closed' || db.closed)) {
            console.log(`STORAGE_MAN: DB escopado '${name}' já estava fechado.`);
          }
        } catch (e) {
          console.error(`STORAGE_MAN: Erro ao fechar DB escopado '${name}':`, e.message);
        }
      }
      this.openedScopedDBs.clear();
    }

    if (this.orbitDB) {
      console.log("STORAGE_MAN: Parando OrbitDB...");
      try { 
        await this.orbitDB.stop(); 
        console.log("STORAGE_MAN: OrbitDB parado."); 
      } catch (e) { 
        console.error("STORAGE_MAN: Erro ao parar OrbitDB", e);
      }
      this.orbitDB = null; // Resetar instância
    }
    // O HeliaNode é gerenciado externamente agora, então não o paramos aqui.
    // if (this.heliaNode) { ... this.heliaNode.stop() ... }
    console.log("STORAGE_MAN: StorageManager fechado (Helia Node não é parado por ele).");
  }
} 