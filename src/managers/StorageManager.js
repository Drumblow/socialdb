import { createHelia } from 'helia';
import { createOrbitDB } from '@orbitdb/core';
import path from 'path';

export class StorageManager {
  constructor(heliaOptions, orbitDbDirectory) {
    this.heliaOptions = heliaOptions; // Opções que incluem config do libp2p e datastore
    this.orbitDbDirectory = orbitDbDirectory; // Ex: path.join(dataDir, 'orbitdb')
    this.heliaNode = null;
    this.orbitDB = null;
  }

  async init() {
    console.log("STORAGE_MAN: Inicializando StorageManager...");
    try {
      console.log("STORAGE_MAN: Tentando criar nó Helia...");
      this.heliaNode = await createHelia(this.heliaOptions);
      console.log("STORAGE_MAN: Nó Helia criado com sucesso.");

      console.log("STORAGE_MAN: Criando instância OrbitDB...");
      this.orbitDB = await createOrbitDB({ 
        ipfs: this.heliaNode, 
        directory: this.orbitDbDirectory 
      });
      console.log(`STORAGE_MAN: Instância OrbitDB criada. Diretório: ${this.orbitDB.directory}`);
      
      return { heliaNode: this.heliaNode, orbitDB: this.orbitDB };
    } catch (error) {
      console.error("STORAGE_MAN: Erro ao inicializar Helia ou OrbitDB:", error);
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

  async close() {
    if (this.orbitDB) {
      console.log("STORAGE_MAN: Parando OrbitDB...");
      try { 
        await this.orbitDB.stop(); 
        console.log("STORAGE_MAN: OrbitDB parado."); 
      } catch (e) { 
        console.error("STORAGE_MAN: Erro ao parar OrbitDB", e);
      }
    }
    if (this.heliaNode) {
      console.log("STORAGE_MAN: Parando Helia...");
      try { 
        await this.heliaNode.stop(); 
        console.log("STORAGE_MAN: Helia (e Libp2p implicitamente) parado."); 
      } catch (e) { 
        console.error("STORAGE_MAN: Erro ao parar Helia", e);
      }
    }
  }
} 