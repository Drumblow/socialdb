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
      
      let entryHash = null; // Declarar fora do try
      try {
        // userPostsDB.add() retorna o hash da entrada adicionada.
        entryHash = await userPostsDB.add({ text, timestamp: Date.now(), author: coreApi.getPeerId() });
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): New post created. Entry hash: ${entryHash}`);
        return entryHash;
      } catch (error) {
        if (error.message && error.message.includes('PublishError.NoPeersSubscribedToTopic')) {
          coreApi.log(`Posts Addon (ID: ${addonContext.id}): Post created locally (hash: ${entryHash || 'N/A'}), but publish failed (no peers).`);
        } else {
          coreApi.log(`Posts Addon (ID: ${addonContext.id}): Error creating post in userPostsDB.add: ${error.message}`);
        }
        // console.error('Posts Addon createPost full error:', error); // Log detalhado opcional
        throw error; // Relançar para que o chamador esteja ciente e possa tratar.
      }
    }

    async function getPosts(options = {}) {
      if (!userPostsDB) {
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Cannot get posts, DB not available.`);
        throw new Error('PostsAddon: Database not available to get posts.');
      }
      try {
        const { limit = undefined, offset = 0 } = options; // Default offset 0, no limit by default for all()

        let allPostEntries = await userPostsDB.all();
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Retrieved ${allPostEntries.length} total posts before pagination.`);

        // Ordenar por timestamp (mais recente primeiro) antes de paginar, se o timestamp existir
        // Isso é importante para uma paginação consistente.
        allPostEntries.sort((a, b) => (b.value?.timestamp || 0) - (a.value?.timestamp || 0));

        let paginatedEntries = allPostEntries;
        if (typeof limit === 'number' && limit > 0) {
          paginatedEntries = allPostEntries.slice(offset, offset + limit);
        } else if (offset > 0) { // Se offset é usado, mas não há limit, pegar tudo desde o offset
          paginatedEntries = allPostEntries.slice(offset);
        }
        // Se limit não for um número > 0, retornamos tudo (respeitando o offset se houver)

        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Returning ${paginatedEntries.length} posts after pagination (limit: ${limit}, offset: ${offset}).`);
        return paginatedEntries.map(post => post.value);
      } catch (error) {
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Error getting posts: ${error.message}`);
        throw error;
      }
    }

    async function deletePost(postHash) {
      if (!userPostsDB) {
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Cannot delete post, DB not available.`);
        throw new Error('PostsAddon: Database not available to delete post.');
      }
      if (!postHash || typeof postHash !== 'string' || !postHash.trim()) {
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Cannot delete post, postHash is invalid.`);
        throw new Error('Post hash cannot be empty.');
      }

      try {
        // const postEntry = await userPostsDB.get(postHash); // .get() não existe em FeedStore para buscar por hash diretamente
        const allEntries = await userPostsDB.all();
        const postEntry = allEntries.find(entry => entry.hash === postHash);

        if (!postEntry) {
          throw new Error('Post not found.');
        }

        // O valor está em postEntry.value para FeedStore após o .get()
        const postAuthor = postEntry.value.author;
        const currentUserId = await coreApi.getPeerId();

        if (postAuthor !== currentUserId) {
          coreApi.log(`Posts Addon (ID: ${addonContext.id}): User ${currentUserId} not authorized to delete post ${postHash} owned by ${postAuthor}.`);
          throw new Error('User not authorized to delete this post.');
        }

        await userPostsDB.remove(postHash);
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Post ${postHash} deleted successfully by ${currentUserId}.`);
        return { success: true, hash: postHash };
      } catch (error) {
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Error deleting post ${postHash}: ${error.message}`);
        // Não relançar o erro aqui se for um erro "conhecido" como 'Post not found' ou 'User not authorized'
        // mas sim retornar um objeto de erro ou deixar que o erro original seja propagado
        // Por enquanto, vamos relançar para que os testes possam capturá-lo diretamente
        // Certificar que o erro original é relançado para os testes de expect(..).rejects.toThrow()
        throw error;
      }
    }

    async function editPost(postHash, newText) {
      if (!userPostsDB) {
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Cannot edit post, DB not available.`);
        throw new Error('PostsAddon: Database not available to edit post.');
      }
      if (!postHash || typeof postHash !== 'string' || !postHash.trim()) {
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Cannot edit post, postHash is invalid.`);
        throw new Error('Post hash cannot be empty for editing.');
      }
      if (!newText || typeof newText !== 'string' || !newText.trim()) {
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Cannot edit post, newText is invalid.`);
        throw new Error('New post text cannot be empty.');
      }

      let newEntryHash = null; // Declarar ANTES do try para estar no escopo do catch
      try {
        const allEntries = await userPostsDB.all();
        const originalPostEntry = allEntries.find(entry => entry.hash === postHash);

        if (!originalPostEntry) {
          throw new Error('Original post not found for editing.');
        }

        const originalPostAuthor = originalPostEntry.value.author;
        const currentUserId = await coreApi.getPeerId();

        if (originalPostAuthor !== currentUserId) {
          coreApi.log(`Posts Addon (ID: ${addonContext.id}): User ${currentUserId} not authorized to edit post ${postHash} owned by ${originalPostAuthor}.`);
          throw new Error('User not authorized to edit this post.');
        }

        // Criar a nova entrada (editada)
        const editedPostData = {
          text: newText,
          timestamp: Date.now(),
          author: originalPostAuthor, // Mantém o autor original
          editedFromHash: postHash // Opcional: referência ao post original
        };

        // newEntryHash já foi declarada acima
        newEntryHash = await userPostsDB.add(editedPostData);
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Post ${postHash} edited successfully by ${currentUserId}. New entry hash: ${newEntryHash}`);
        return newEntryHash; // Retorna o hash da nova entrada/versão

      } catch (error) {
        // newEntryHash é null se o erro ocorreu antes da atribuição por userPostsDB.add()
        const hashForLog = newEntryHash ? newEntryHash : 'N/A';
        if (error.message && error.message.includes('PublishError.NoPeersSubscribedToTopic')) {
          coreApi.log(`Posts Addon (ID: ${addonContext.id}): Post ${postHash} edited locally (new hash: ${hashForLog}), but publish failed (no peers).`);
        } else {
          coreApi.log(`Posts Addon (ID: ${addonContext.id}): Error editing post ${postHash}: ${error.message}`);
        }
        throw error;
      }
    }

    async function getPostsByAuthor(authorId, options = {}) {
      if (!userPostsDB) {
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Cannot get posts by author, DB not available.`);
        throw new Error('PostsAddon: Database not available.');
      }
      if (!authorId || typeof authorId !== 'string' || !authorId.trim()) {
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Cannot get posts by author, authorId is invalid.`);
        throw new Error('Author ID cannot be empty.');
      }

      try {
        const { limit = undefined, offset = 0 } = options;

        const allPostEntries = await userPostsDB.all();
        let postsByAuthorEntries = allPostEntries
          .filter(entry => entry.value && entry.value.author === authorId);
        
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Found ${postsByAuthorEntries.length} total posts for author ${authorId} before pagination.`);

        // Ordenar por timestamp (mais recente primeiro) antes de paginar
        postsByAuthorEntries.sort((a, b) => (b.value?.timestamp || 0) - (a.value?.timestamp || 0));

        let paginatedEntries = postsByAuthorEntries;
        if (typeof limit === 'number' && limit > 0) {
          paginatedEntries = postsByAuthorEntries.slice(offset, offset + limit);
        } else if (offset > 0) {
          paginatedEntries = postsByAuthorEntries.slice(offset);
        }

        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Returning ${paginatedEntries.length} posts for author ${authorId} after pagination (limit: ${limit}, offset: ${offset}).`);
        return paginatedEntries.map(entry => entry.value);
      } catch (error) {
        coreApi.log(`Posts Addon (ID: ${addonContext.id}): Error getting posts by author ${authorId}: ${error.message}`);
        throw error;
      }
    }

    return {
      status: 'initialized',
      manifestId: this.manifest.id,
      createPost,
      getPosts,
      deletePost,
      editPost,
      getPostsByAuthor,
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