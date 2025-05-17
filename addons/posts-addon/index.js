export default {
  manifest: {
    id: 'posts-addon',
    name: 'Posts Addon',
    version: '0.0.1',
    description: 'An addon for creating and managing user posts.',
    permissions: ['core:log', 'core:storage:scoped']
  },

  async initialize(coreApi, addonContext) {
    const currentAddonId = addonContext.id;
    coreApi.log(`Posts Addon (ID: ${currentAddonId}): Initializing...`);

    let userPostsDB = null;
    try {
      // Usar dbType 'feed' para posts.
      // O nome 'user_posts' é interno para este addon, o StorageManager o escopará.
      userPostsDB = await coreApi.storageGetScopedDB('user_posts', 'feed');
      if (userPostsDB) {
        coreApi.log(`Posts Addon (ID: ${currentAddonId}): DB 'user_posts' (feed) obtained. Address: ${userPostsDB.address}`);
        // Adicionar listeners ao DB se necessário, como no StorageManager
        userPostsDB.events.on('update', (entry) => {
            coreApi.log(`Posts Addon (ID: ${currentAddonId}): DB 'user_posts' update event. Entry: ${JSON.stringify(entry.payload.value)}`);
        });
         userPostsDB.events.on('ready', () => {
            coreApi.log(`Posts Addon (ID: ${currentAddonId}): DB 'user_posts' is ready.`);
        });

      } else {
        coreApi.log(`Posts Addon (ID: ${currentAddonId}): Failed to obtain DB 'user_posts'. StorageManager might be unavailable or permission denied.`);
      }
    } catch (e) {
      coreApi.log(`Posts Addon (ID: ${currentAddonId}): Error obtaining or setting up DB 'user_posts': ${e.message}`);
      console.error(e); // Logar o erro completo para depuração
    }

    async function createPost(text) {
      if (!userPostsDB) {
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Cannot create post, DB not available.`);
        // Lançar um erro pode ser melhor para consistência, mas null também é tratável.
        throw new Error('PostsAddon: Database not available to create post.'); 
      }
      if (!text || typeof text !== 'string' || !text.trim()) {
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Cannot create post, text is invalid.`);
        throw new Error('Post text cannot be empty.');
      }
      
      try {
        // userPostsDB.add() retorna o hash da entrada adicionada.
        const entryHash = await userPostsDB.add({ text, timestamp: Date.now(), author: coreApi.getPeerId() });
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): New post created. Entry hash: ${entryHash}`);
        return entryHash;
      } catch (error) {
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Error creating post in userPostsDB.add: ${error.message}`);
        // console.error('Posts Addon createPost full error:', error); // Log detalhado opcional
        throw error; // Relançar para que o chamador esteja ciente e possa tratar.
      }
    }

    async function getPosts() {
      if (!userPostsDB) {
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Cannot get posts, DB not available.`);
        throw new Error('PostsAddon: Database not available to get posts.');
      }
      try {
        const posts = await userPostsDB.all();
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Retrieved ${posts.length} posts.`);
        // Mapear para retornar apenas o valor, pois é isso que o usuário do addon provavelmente quer.
        // A estrutura completa com hash, etc., pode ser exposta por outra função se necessário.
        return posts.map(post => post.value);
      } catch (error) {
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Error getting posts: ${error.message}`);
        throw error;
      }
    }

    return {
      status: 'initialized',
      manifestId: this.manifest.id,
      createPost,
      getPosts,
      _getDB: () => userPostsDB
    };
  },

  async terminate(coreApi, addonContext) {
    const currentAddonId = addonContext.id;
    if (coreApi && typeof coreApi.log === 'function') {
      coreApi.log(`Posts Addon (ID: ${currentAddonId}): Terminating...`);
    }
    // Qualquer limpeza específica do addon (ex: remover listeners de DB)
    // O StorageManager deve lidar com o fechamento do DB em si.
    return { status: 'terminated' };
  }
}; 