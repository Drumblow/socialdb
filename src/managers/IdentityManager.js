import fs from 'fs/promises';
import path from 'path';
import { FsDatastore } from 'datastore-fs';

// Função para GARANTIR QUE O DIRETÓRIO DE DADOS EXISTA (PeerId será gerenciado pelo libp2p via datastore)
async function ensureDataDirExists(dataDirForKeys) {
  try {
    await fs.mkdir(dataDirForKeys, { recursive: true });
    // console.log(`ID_MAN: Diretório de dados verificado/criado: ${dataDirForKeys}`);
  } catch (error) {
    console.error(`ID_MAN: Falha ao criar diretório de dados ${dataDirForKeys}:`, error);
    throw error;
  }
}

export class IdentityManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.datastore = null;
  }

  async init() {
    console.log(`ID_MAN: Inicializando IdentityManager com diretório de dados: ${this.dataDir}`);
    await ensureDataDirExists(this.dataDir);

    const datastorePath = path.join(this.dataDir, 'datastore');
    await ensureDataDirExists(datastorePath); // Garante que o subdiretório do datastore também exista
    
    this.datastore = new FsDatastore(datastorePath);
    // FsDatastore abre automaticamente no primeiro uso ou pode ser aberto explicitamente se necessário.
    // Se precisar abrir explicitamente:
    // await this.datastore.open(); 
    console.log(`ID_MAN: FsDatastore configurado em: ${datastorePath}`);
    return this.datastore;
  }

  getDatastore() {
    if (!this.datastore) {
      throw new Error("ID_MAN: Datastore não inicializado. Chame init() primeiro.");
    }
    return this.datastore;
  }

  async close() {
    if (this.datastore) {
      try {
        await this.datastore.close();
        console.log("ID_MAN: FsDatastore fechado.");
      } catch (error) {
        console.error("ID_MAN: Erro ao fechar FsDatastore:", error);
      }
    }
  }
} 