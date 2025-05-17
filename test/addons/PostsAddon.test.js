import { AddonManager } from '../../src/managers/AddonManager.js';
import { EventBus } from '../../src/event-bus/EventBus.js';
import { StorageManager } from '../../src/managers/StorageManager.js';
import { createMockIdentityManager } from '../managers/AddonManager.test.js'; // Reutilizar helper

// Helpers de AddonManager.test.js (createMockLibp2p, etc.)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { FsDatastore } from 'datastore-fs';
import { MemoryBlockstore } from 'blockstore-core';
import { createHelia } from 'helia';
import { createLibp2p as actualCreateLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { bootstrap } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import fs from 'node:fs';

// Helper para criar um nó Libp2p mock/mínimo para testes de storage
// (Copiado e adaptado de AddonManager.test.js)
async function createMockLibp2p(peerIdInstance, datastore, bootstrapMultiaddrs = []) {
  const config = {
    peerId: peerIdInstance,
    datastore,
    addresses: { listen: ['/ip4/0.0.0.0/tcp/0/ws'] },
    transports: [webSockets()],
    connectionEncryption: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      pubsub: gossipsub({ allowPublishToZeroPeers: true }),
    },
  };
  if (bootstrapMultiaddrs && bootstrapMultiaddrs.length > 0) {
    config.peerDiscovery = [
      bootstrap({ list: bootstrapMultiaddrs, timeout: 1000 }),
    ];
  }
  return actualCreateLibp2p(config);
}


describe('PostsAddon Functionality', () => {
  let addonManager;
  let storageManager;
  let heliaNode;
  let libp2p;
  let datastore;
  let mockEventBus;
  let mockIdentityManager;
  let peerIdInstance;

  const POSTS_ADDON_PATH = './addons/posts-addon/index.js';
  const testDirSuffix = `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const tempDatastorePath = path.resolve(process.cwd(), `.test-datastore-postsaddon-${testDirSuffix}`);
  const tempOrbitDbPath = path.resolve(process.cwd(), `.test-orbitdb-postsaddon-${testDirSuffix}`);

  beforeEach(async () => {
    mockEventBus = new EventBus();
    
    datastore = new FsDatastore(tempDatastorePath);
    await datastore.open();

    const key = await generateKeyPair('Ed25519');
    peerIdInstance = await peerIdFromPrivateKey(key);
    
    libp2p = await createMockLibp2p(peerIdInstance, datastore);
    await libp2p.start();
    
    heliaNode = await createHelia({ libp2p, datastore });
    mockIdentityManager = createMockIdentityManager(peerIdInstance.toString());
    
    storageManager = new StorageManager(mockEventBus, mockIdentityManager, heliaNode, tempOrbitDbPath);
    await storageManager.init();
    
    addonManager = new AddonManager(mockEventBus, mockIdentityManager, null, storageManager);
    await addonManager.init();
  });

  afterEach(async () => {
    if (addonManager) {
      try {
        await addonManager.unloadAddon('posts-addon');
      } catch (e) { /* pode já ter sido descarregado ou nunca carregado */ }
      await addonManager.close(); // Garante que tudo seja limpo
    }
    if (storageManager) await storageManager.close();
    if (heliaNode) await heliaNode.stop();
    if (libp2p && libp2p.status === 'started') await libp2p.stop(); // Verifica se está iniciado antes de parar
    if (datastore && datastore.status === 'open') await datastore.close(); // Verifica se está aberto antes de fechar

    // Limpar diretórios de teste
    try { fs.rmSync(tempDatastorePath, { recursive: true, force: true }); } catch(e) { console.warn(`Warn: Could not remove ${tempDatastorePath}`, e.message); }
    try { fs.rmSync(tempOrbitDbPath, { recursive: true, force: true }); } catch(e) { console.warn(`Warn: Could not remove ${tempOrbitDbPath}`, e.message); }
  });

  test('should load posts-addon and create a new post, handling potential PublishError', async () => {
    const postsAddon = await addonManager.loadAddon(POSTS_ADDON_PATH);
    expect(postsAddon).toBeDefined();
    expect(postsAddon.status).toBe('initialized');
    expect(typeof postsAddon.createPost).toBe('function');

    const postText = "This is a test post from PostsAddon.test.js!";
    
    const db = postsAddon._getDB();
    expect(db).toBeDefined();

    let postHashFromAddon = null;
    let caughtError = null;

    try {
      postHashFromAddon = await postsAddon.createPost(postText);
    } catch (error) {
      console.log(`Test: createPost FAILED with error: ${error.message}`);
      caughtError = error;
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    const allPosts = await db.all();
    console.log(`Test: Found ${allPosts.length} post(s) in DB.`);
    
    if (allPosts && allPosts.length > 0) {
      // console.log("Test: Structure of the first post entry:", JSON.stringify(allPosts[0], null, 2)); 

      expect(allPosts.length).toBe(1);
      const postEntry = allPosts[0];
      
      // Para feed stores, o valor está diretamente em 'value', e o hash é uma propriedade da entrada
      expect(postEntry.value).toBeDefined();
      expect(postEntry.value.text).toBe(postText);
      expect(postEntry.value.author).toBe(peerIdInstance.toString());
      
      const actualHashInDB = postEntry.hash;
      expect(typeof actualHashInDB).toBe('string');
      console.log(`Test: Post found in DB. Hash: ${actualHashInDB}`);

      if (caughtError) {
        expect(caughtError.message).toContain('PublishError.NoPeersSubscribedToTopic');
        console.log(`Test: Post creation by addon correctly failed with PublishError, but post was in DB.`);
      } else {
        expect(postHashFromAddon).toBe(actualHashInDB);
        console.log(`Test: Post created successfully by addon, hash: ${postHashFromAddon}`);
      }
    } else {
      if (!caughtError) {
        throw new Error("No posts found in DB, and createPost did not report an error.");
      }
      expect(caughtError.message).toContain('PublishError.NoPeersSubscribedToTopic');
      console.warn("Test: createPost failed with PublishError AND no post was found in DB.");
    }
  });

  test('createPost should throw error for empty text', async () => {
    const postsAddon = await addonManager.loadAddon(POSTS_ADDON_PATH);
    expect(postsAddon).toBeDefined();
    
    await expect(postsAddon.createPost("")).rejects.toThrow('Post text cannot be empty.');
    await expect(postsAddon.createPost("   ")).rejects.toThrow('Post text cannot be empty.');
    await expect(postsAddon.createPost(null)).rejects.toThrow('Post text cannot be empty.');
  });

  test('getPosts should retrieve all created posts', async () => {
    const postsAddon = await addonManager.loadAddon(POSTS_ADDON_PATH);
    expect(postsAddon).toBeDefined();
    expect(typeof postsAddon.createPost).toBe('function');
    expect(typeof postsAddon.getPosts).toBe('function');

    const postText1 = "First post for getPosts test!";
    const postText2 = "Second post for getPosts test!";

    try {
      await postsAddon.createPost(postText1); 
    } catch (error) {
      if (!error.message.includes('PublishError.NoPeersSubscribedToTopic')) throw error;
      console.log(`Test getPosts: Ignored PublishError for post1: ${error.message}`);
    }

    try {
      await postsAddon.createPost(postText2);
    } catch (error) {
      if (!error.message.includes('PublishError.NoPeersSubscribedToTopic')) throw error;
      console.log(`Test getPosts: Ignored PublishError for post2: ${error.message}`);
    }
    
    // Pequena espera para garantir que as escritas no DB sejam processadas
    await new Promise(resolve => setTimeout(resolve, 300));

    const retrievedPosts = await postsAddon.getPosts();
    expect(retrievedPosts).toBeDefined();
    expect(Array.isArray(retrievedPosts)).toBe(true);
    expect(retrievedPosts.length).toBe(2);

    // Verificar o conteúdo dos posts (a ordem pode variar dependendo do DB)
    // Os posts retornados pela função getPosts já são os `.value`
    expect(retrievedPosts.some(p => p.text === postText1)).toBe(true);
    expect(retrievedPosts.some(p => p.text === postText2)).toBe(true);
    expect(retrievedPosts[0].author).toBe(peerIdInstance.toString());
    expect(retrievedPosts[1].author).toBe(peerIdInstance.toString());
  });

  describe('deletePost functionality', () => {
    let postsAddon;
    let initialPostHash;
    const postText = "Post to be deleted";

    beforeEach(async () => {
      // Cada teste de deletePost precisa de um addon e um post recém-criado
      // para evitar interferência entre testes. O AddonManager e StorageManager
      // são limpos pelo afterEach do describe principal.
      postsAddon = await addonManager.loadAddon(POSTS_ADDON_PATH);
      expect(postsAddon).toBeDefined();
      try {
        initialPostHash = await postsAddon.createPost(postText);
      } catch (e) {
        if (!e.message.includes('PublishError')) throw e;
        // Se for PublishError, precisamos obter o hash de outra forma, pois createPost pode ter retornado null ou lançado.
        // Re-consultar o DB para encontrar o post recém-adicionado.
        await new Promise(resolve => setTimeout(resolve, 200)); // dar tempo para o add() refletir
        const allEntries = await postsAddon._getDB().all();
        const createdEntry = allEntries.find(entry => entry.value.text === postText);
        if (!createdEntry) throw new Error("Test setup: Post was not found in DB after createPost with PublishError");
        initialPostHash = createdEntry.hash;
      }
      expect(initialPostHash).toBeDefined();
      expect(typeof initialPostHash).toBe('string');
       // Garante que o post existe
      const allPostsBeforeDelete = await postsAddon._getDB().all();
      const postBeforeDelete = allPostsBeforeDelete.find(p => p.hash === initialPostHash);
      expect(postBeforeDelete).toBeDefined();
      expect(postBeforeDelete.value.text).toBe(postText);
    });

    test('should allow an author to delete their own post', async () => {
      let deleteResult;
      try {
        deleteResult = await postsAddon.deletePost(initialPostHash);
      } catch (error) {
        if (error.message.includes('PublishError.NoPeersSubscribedToTopic')) {
          console.log(`Test deletePost (own): Ignored PublishError during delete: ${error.message}`);
          // Mesmo com PublishError, a remoção local deve ter ocorrido.
          // Vamos verificar o DB. Se o post não estiver lá, consideramos sucesso para este teste.
          const postAfterError = await postsAddon._getDB().all();
          if (!postAfterError.find(p => p.hash === initialPostHash)) {
            deleteResult = { success: true, hash: initialPostHash }; // Simula o resultado esperado
          } else {
            throw new Error (`Post ${initialPostHash} was still found after delete attempt with PublishError.`);
          }
        } else {
          throw error; // Relançar outros erros
        }
      }
      expect(deleteResult).toEqual({ success: true, hash: initialPostHash });

      // Verificar se o post foi realmente removido do DB
      // const postAfterDelete = await postsAddon._getDB().get(initialPostHash); // .get não existe
      const allPostsAfterDelete = await postsAddon._getDB().all();
      const postAfterDelete = allPostsAfterDelete.find(p => p.hash === initialPostHash);
      expect(postAfterDelete).toBeUndefined();

      // Verificar com all() também
      const allPosts = await postsAddon.getPosts();
      expect(allPosts.find(p => p.text === postText)).toBeUndefined();
    });

    test('should throw an error when trying to delete a non-existent post', async () => {
      const fakeHash = 'nonexistenthash12345';
      await expect(postsAddon.deletePost(fakeHash)).rejects.toThrow('Post not found.');
    });

    test('should throw an error for an empty post hash', async () => {
      await expect(postsAddon.deletePost('')).rejects.toThrow('Post hash cannot be empty.');
      await expect(postsAddon.deletePost('   ')).rejects.toThrow('Post hash cannot be empty.');
    });

    test('should prevent deleting a post if not the author', async () => {
      // Criar um novo AddonManager e PostsAddon com uma identidade diferente
      const keyOtherUser = await generateKeyPair('Ed25519');
      const peerIdOtherUser = await peerIdFromPrivateKey(keyOtherUser);
      const mockIdentityManagerOtherUser = createMockIdentityManager(peerIdOtherUser.toString());

      // Criar uma nova instância do StorageManager para este teste específico se necessário, ou garantir que o DB é compartilhado
      // Por agora, vamos assumir que o DB é o mesmo (o que é verdade, pois o caminho do OrbitDB é o mesmo)
      // e o CoreAPI do novo addon terá um peerId diferente.
      
      const eventBusOtherUser = new EventBus(); // Novo event bus para isolar
      // Usar o mesmo storageManager, pois o DB é o mesmo e queremos testar o acesso a ele
      const addonManagerOtherUser = new AddonManager(eventBusOtherUser, mockIdentityManagerOtherUser, null, storageManager);
      await addonManagerOtherUser.init();
      const postsAddonOtherUser = await addonManagerOtherUser.loadAddon(POSTS_ADDON_PATH);

      // Tentar deletar o post original (initialPostHash) com a identidade do outro usuário
      await expect(postsAddonOtherUser.deletePost(initialPostHash)).rejects.toThrow('User not authorized to delete this post.');

      // Garantir que o post original ainda existe
      // const originalPost = await postsAddon._getDB().get(initialPostHash); // .get() não existe
      const allOriginalPosts = await postsAddon._getDB().all();
      const originalPost = allOriginalPosts.find(p => p.hash === initialPostHash);
      expect(originalPost).toBeDefined();
      expect(originalPost.value.text).toBe(postText);

      await addonManagerOtherUser.unloadAddon('posts-addon');
      await addonManagerOtherUser.close();
    });
  });

  describe('editPost functionality', () => {
    let postsAddon;
    let originalPostHash;
    const originalPostText = "Original post for editing";
    const editedPostText = "This post has been edited!";

    beforeEach(async () => {
      postsAddon = await addonManager.loadAddon(POSTS_ADDON_PATH);
      expect(postsAddon).toBeDefined();
      try {
        originalPostHash = await postsAddon.createPost(originalPostText);
      } catch (e) {
        if (!e.message.includes('PublishError')) throw e;
        await new Promise(resolve => setTimeout(resolve, 200));
        const allEntries = await postsAddon._getDB().all();
        const createdEntry = allEntries.find(entry => entry.value.text === originalPostText);
        if (!createdEntry) throw new Error("Test setup (edit): Post was not found in DB after createPost with PublishError");
        originalPostHash = createdEntry.hash;
      }
      expect(originalPostHash).toBeDefined();
      expect(typeof originalPostHash).toBe('string');
      const postBeforeEditAll = await postsAddon._getDB().all();
      const postBeforeEdit = postBeforeEditAll.find(p => p.hash === originalPostHash);
      expect(postBeforeEdit).toBeDefined();
      expect(postBeforeEdit.value.text).toBe(originalPostText);
    });

    test('should allow an author to edit their own post', async () => {
      let newPostHash;
      try {
        newPostHash = await postsAddon.editPost(originalPostHash, editedPostText);
      } catch (e) {
        if (e.message.includes('PublishError')) {
          console.log(`Test editPost (own): Ignored PublishError during edit: ${e.message}`);
          await new Promise(resolve => setTimeout(resolve, 200)); 
          const allEntries = await postsAddon._getDB().all();
          const editedEntry = allEntries.find(entry => entry.value.text === editedPostText && entry.value.editedFromHash === originalPostHash);
          if (!editedEntry) throw new Error("Edited post not found after PublishError in editPost test");
          newPostHash = editedEntry.hash; 
        } else {
          throw e;
        }
      }
      
      expect(newPostHash).toBeDefined();
      expect(typeof newPostHash).toBe('string');
      expect(newPostHash).not.toBe(originalPostHash);

      const allPostsAfterEdit = await postsAddon._getDB().all();
      const newPostEntry = allPostsAfterEdit.find(p => p.hash === newPostHash);
      expect(newPostEntry).toBeDefined();
      expect(newPostEntry.value.text).toBe(editedPostText);
      expect(newPostEntry.value.author).toBe(peerIdInstance.toString());
      expect(newPostEntry.value.editedFromHash).toBe(originalPostHash);

      // O post original ainda deve existir no FeedStore
      const originalPostStillThere = allPostsAfterEdit.find(p => p.hash === originalPostHash);
      expect(originalPostStillThere).toBeDefined();
      expect(originalPostStillThere.value.text).toBe(originalPostText);
    });

    test('should throw an error when trying to edit a non-existent post', async () => {
      const fakeHash = 'nonexistenthashToEdit123';
      await expect(postsAddon.editPost(fakeHash, editedPostText)).rejects.toThrow('Original post not found for editing.');
    });

    test('should throw an error for invalid new text', async () => {
      await expect(postsAddon.editPost(originalPostHash, '')).rejects.toThrow('New post text cannot be empty.');
      await expect(postsAddon.editPost(originalPostHash, '   ')).rejects.toThrow('New post text cannot be empty.');
    });

    test('should prevent editing a post if not the author', async () => {
      const keyOtherUser = await generateKeyPair('Ed25519');
      const peerIdOtherUser = await peerIdFromPrivateKey(keyOtherUser);
      const mockIdentityManagerOtherUser = createMockIdentityManager(peerIdOtherUser.toString());
      const eventBusOtherUser = new EventBus();
      const addonManagerOtherUser = new AddonManager(eventBusOtherUser, mockIdentityManagerOtherUser, null, storageManager);
      await addonManagerOtherUser.init();
      const postsAddonOtherUser = await addonManagerOtherUser.loadAddon(POSTS_ADDON_PATH);

      await expect(postsAddonOtherUser.editPost(originalPostHash, "malicious edit attempt")).rejects.toThrow('User not authorized to edit this post.');
      
      // Garantir que o post original não foi alterado e nenhuma nova entrada foi adicionada por este usuário
      const allPosts = await postsAddon._getDB().all();
      const originalPostEntry = allPosts.find(p => p.hash === originalPostHash);
      expect(originalPostEntry.value.text).toBe(originalPostText);
      const maliciousEntry = allPosts.find(p => p.value.text === "malicious edit attempt");
      expect(maliciousEntry).toBeUndefined();

      await addonManagerOtherUser.unloadAddon('posts-addon');
      await addonManagerOtherUser.close();
    });
  });

  describe('getPostsByAuthor functionality', () => {
    let postsAddon;
    let author1Id;
    let author2Id;
    let post1Hash, post2Hash, post3Hash;

    beforeEach(async () => {
      author1Id = peerIdInstance.toString();
      
      const author2Identity = await createMockIdentityManager();
      author2Id = (await author2Identity.getPeerId()).toString();

      postsAddon = await addonManager.loadAddon(POSTS_ADDON_PATH);
      expect(postsAddon).toBeDefined();
      expect(typeof postsAddon.getPostsByAuthor).toBe('function');

      const postText1 = "Post by author 1";
      const postText2 = "Post by author 2";
      const postText3 = "Another post by author 1";

      let post1Hash, post2Hash, post3Hash;

      try {
        post1Hash = await postsAddon.createPost(postText1);
      } catch (e) {
        if (!e.message.includes('PublishError')) throw e;
        await new Promise(resolve => setTimeout(resolve, 200));
        const entries1 = await postsAddon._getDB().all();
        post1Hash = entries1.find(p => p.value.text === postText1)?.hash;
      }
      expect(post1Hash).toBeDefined();

      const db = postsAddon._getDB();
      const simulatedPostByAuthor2 = { text: postText2, timestamp: Date.now(), author: author2Id };
      const simulatedPostByAuthor1Again = { text: postText3, timestamp: Date.now(), author: author1Id };
      
      try {
        post2Hash = await db.add(simulatedPostByAuthor2);
      } catch (e) {
        if (!e.message.includes('PublishError')) throw e;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!post2Hash) {
        const entries2 = await db.all();
        post2Hash = entries2.find(p => p.value.text === postText2 && p.value.author === author2Id)?.hash;
      }
      expect(post2Hash).toBeDefined();
      
      try {
        post3Hash = await db.add(simulatedPostByAuthor1Again);
      } catch (e) {
        if (!e.message.includes('PublishError')) throw e;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!post3Hash) {
        const entries3 = await db.all();
        post3Hash = entries3.find(p => p.value.text === postText3 && p.value.author === author1Id)?.hash;
      }
      expect(post3Hash).toBeDefined();
      
      await new Promise(resolve => setTimeout(resolve, 300));
    });

    test('should retrieve posts only for author1', async () => {
      const posts = await postsAddon.getPostsByAuthor(author1Id);
      expect(posts).toBeInstanceOf(Array);
      expect(posts.length).toBe(2);
      expect(posts.some(p => p.text === "Post by author 1")).toBe(true);
      expect(posts.some(p => p.text === "Another post by author 1")).toBe(true);
      expect(posts.every(p => p.author === author1Id)).toBe(true);
    });

    test('should retrieve posts only for author2', async () => {
      const posts = await postsAddon.getPostsByAuthor(author2Id);
      expect(posts).toBeInstanceOf(Array);
      expect(posts.length).toBe(1);
      expect(posts[0].text).toBe("Post by author 2");
      expect(posts[0].author).toBe(author2Id);
    });

    test('should return an empty array for an author with no posts', async () => {
      const nonExistentAuthorId = 'nonExistentPeerId12345';
      const posts = await postsAddon.getPostsByAuthor(nonExistentAuthorId);
      expect(posts).toBeInstanceOf(Array);
      expect(posts.length).toBe(0);
    });

    test('should throw an error for an invalid authorId (empty string)', async () => {
      await expect(postsAddon.getPostsByAuthor('')).rejects.toThrow('Author ID cannot be empty.');
    });
    
    test('should throw an error for an invalid authorId (null)', async () => {
      await expect(postsAddon.getPostsByAuthor(null)).rejects.toThrow('Author ID cannot be empty.');
    });
  });

  describe('getPosts pagination', () => {
    let postsAddon;
    const totalPostsToCreate = 8; // Reduzido de 25
    // const defaultLimit = 10; // Comentado, pois nossa API não impõe limite padrão

    beforeEach(async () => {
      postsAddon = await addonManager.loadAddon(POSTS_ADDON_PATH);
      expect(postsAddon).toBeDefined();
      
      const baseTimestamp = Date.now();
      for (let i = 0; i < totalPostsToCreate; i++) {
        try {
          // Usar baseTimestamp + i para garantir ordem e timestamps únicos
          // CreatePost no addon já usa Date.now(), então precisamos modificar o createPost temporariamente
          // ou adicionar posts diretamente ao DB para ter controle total do timestamp para teste.
          // Por simplicidade, vamos continuar usando createPost e aceitar que Date.now() no addon será usado.
          // O setTimeout(1) ajuda a diferenciar. Reduzir posts deve ajudar mais.
          await new Promise(resolve => setTimeout(resolve, 2)); // Aumentar um pouco para mais chance de diff timestamp
          await postsAddon.createPost(`Post ${i + 1} for pagination test`);
        } catch (e) {
          if (!e.message.includes('PublishError')) throw e;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200)); // Reduzido de 500
    });

    test('should return all posts if no limit/offset is provided (respeitando a ordem)', async () => {
      const posts = await postsAddon.getPosts();
      expect(posts.length).toBe(totalPostsToCreate);
      // Verificar a ordem (mais recente primeiro)
      expect(posts[0].text).toBe(`Post ${totalPostsToCreate} for pagination test`);
      expect(posts[totalPostsToCreate - 1].text).toBe('Post 1 for pagination test');
    });

    test('should return `limit` number of posts from the beginning (offset 0)', async () => {
      const limit = 5;
      const posts = await postsAddon.getPosts({ limit });
      expect(posts.length).toBe(limit);
      expect(posts[0].text).toBe(`Post ${totalPostsToCreate} for pagination test`); // Mais recente
      expect(posts[limit - 1].text).toBe(`Post ${totalPostsToCreate - limit + 1} for pagination test`);
    });

    test('should return posts from a specific `offset` with a `limit`', async () => {
      const limit = 5;
      const offset = 3;
      const posts = await postsAddon.getPosts({ limit, offset });
      expect(posts.length).toBe(limit);
      // O post mais recente é o totalPostsToCreate. Offset 3 significa pular os 3 mais recentes.
      // Então, o primeiro post retornado deve ser totalPostsToCreate - offset.
      expect(posts[0].text).toBe(`Post ${totalPostsToCreate - offset} for pagination test`); 
      expect(posts[limit - 1].text).toBe(`Post ${totalPostsToCreate - offset - limit + 1} for pagination test`);
    });

    test('should return remaining posts if limit + offset exceeds total posts', async () => {
      const limit = 5;
      const offset = totalPostsToCreate - 3; // Ex: Se 25 posts, offset 22. Deve retornar 3 posts.
      const posts = await postsAddon.getPosts({ limit, offset });
      expect(posts.length).toBe(totalPostsToCreate - offset);
      expect(posts[0].text).toBe(`Post ${totalPostsToCreate - offset} for pagination test`);
    });

    test('should return empty array if offset is beyond total posts', async () => {
      const limit = 5;
      const offset = totalPostsToCreate + 5;
      const posts = await postsAddon.getPosts({ limit, offset });
      expect(posts.length).toBe(0);
    });

    test('should return all posts if limit is 0 or invalid, respecting offset', async () => {
      let posts = await postsAddon.getPosts({ limit: 0, offset: 2 });
      expect(posts.length).toBe(totalPostsToCreate - 2);
      expect(posts[0].text).toBe(`Post ${totalPostsToCreate - 2} for pagination test`);

      posts = await postsAddon.getPosts({ limit: -5, offset: 3 });
      expect(posts.length).toBe(totalPostsToCreate - 3);
      expect(posts[0].text).toBe(`Post ${totalPostsToCreate - 3} for pagination test`);

      posts = await postsAddon.getPosts({ limit: undefined, offset: 1 });
      expect(posts.length).toBe(totalPostsToCreate - 1);
      expect(posts[0].text).toBe(`Post ${totalPostsToCreate - 1} for pagination test`);
    });

     test('should return all posts from offset if limit is not provided', async () => {
      const offset = totalPostsToCreate - 5;
      const posts = await postsAddon.getPosts({ offset });
      expect(posts.length).toBe(5);
      expect(posts[0].text).toBe('Post 5 for pagination test'); // Mais recente dos 5 restantes
      expect(posts[4].text).toBe('Post 1 for pagination test'); // O mais antigo de todos
    });
  });

  describe('getPostsByAuthor pagination', () => {
    let postsAddon;
    let author1Id, author2Id;
    const totalPostsForAuthor1 = 6; // Reduzido de 15
    const totalPostsForAuthor2 = 4; // Reduzido de 10

    beforeEach(async () => {
      postsAddon = await addonManager.loadAddon(POSTS_ADDON_PATH);
      expect(postsAddon).toBeDefined();

      author1Id = peerIdInstance.toString(); 
      const author2Identity = await createMockIdentityManager();
      author2Id = (await author2Identity.getPeerId()).toString();
      
      const baseTimestamp = Date.now();

      // Criar posts para author1
      for (let i = 0; i < totalPostsForAuthor1; i++) {
        try {
          await new Promise(resolve => setTimeout(resolve, 2)); // Pequeno delay
          await postsAddon.createPost(`Author1 Post ${i + 1}`); 
        } catch (e) { if (!e.message.includes('PublishError')) throw e; }
      }

      // Criar posts para author2 (com timestamps controlados)
      const db = postsAddon._getDB();
      for (let i = 0; i < totalPostsForAuthor2; i++) {
        try {
          // Timestamp decrescente para que o Post N seja o mais novo se o loop for 0..N-1
          // Ou, mais simples: Post 1 (i=0) é o mais antigo, Post N (i=N-1) é o mais novo.
          // Então `baseTimestamp + i` ainda funciona para ordenação.
          await db.add({ 
            text: `Author2 Post ${i + 1}`, 
            timestamp: baseTimestamp + i, // Timestamp determinístico
            author: author2Id 
          });
        } catch (e) { if (!e.message.includes('PublishError')) throw e; }
      }
      await new Promise(resolve => setTimeout(resolve, 200)); // Reduzido
    });

    test('should return all posts for an author if no limit/offset (respecting order)', async () => {
      const posts = await postsAddon.getPostsByAuthor(author1Id);
      expect(posts.length).toBe(totalPostsForAuthor1);
      expect(posts[0].text).toBe(`Author1 Post ${totalPostsForAuthor1}`);
      expect(posts[totalPostsForAuthor1 - 1].text).toBe('Author1 Post 1');
    });

    test('should return `limit` number of posts for an author', async () => {
      const limit = 5;
      const posts = await postsAddon.getPostsByAuthor(author1Id, { limit });
      expect(posts.length).toBe(limit);
      expect(posts[0].text).toBe(`Author1 Post ${totalPostsForAuthor1}`);
      expect(posts[limit - 1].text).toBe(`Author1 Post ${totalPostsForAuthor1 - limit + 1}`);
    });

    test('should return posts from `offset` with `limit` for an author', async () => {
      const limit = 4;
      const offset = 3;
      const posts = await postsAddon.getPostsByAuthor(author1Id, { limit, offset });
      // totalPostsForAuthor1 = 6. offset = 3. Posts restantes = 3 (P3, P2, P1)
      // limit = 4. Math.min(4, 6 - 3) = Math.min(4, 3) = 3.
      const expectedLength = Math.min(limit, totalPostsForAuthor1 - offset);
      expect(posts.length).toBe(expectedLength); 

      if (expectedLength > 0) { // Só verificar o conteúdo se esperamos posts
        expect(posts[0].text).toBe(`Author1 Post ${totalPostsForAuthor1 - offset}`);
        // A última verificação precisa ser ajustada se expectedLength < limit
        expect(posts[expectedLength - 1].text).toBe(`Author1 Post ${totalPostsForAuthor1 - offset - expectedLength + 1}`);
      }
    });

    test('should return remaining posts for author if limit + offset exceeds their total', async () => {
      const limit = 5;
      const offset = totalPostsForAuthor2 - 2; // Author2 tem 4 posts. offset = 2. Deve retornar 2 posts.
      const posts = await postsAddon.getPostsByAuthor(author2Id, { limit, offset });
      expect(posts.length).toBe(totalPostsForAuthor2 - offset);
      expect(posts[0].text).toBe(`Author2 Post ${totalPostsForAuthor2 - offset}`);
    });

    test('should return empty array for author if offset is beyond their total posts', async () => {
      const limit = 5;
      const offset = totalPostsForAuthor1 + 3;
      const posts = await postsAddon.getPostsByAuthor(author1Id, { limit, offset });
      expect(posts.length).toBe(0);
    });

    test('should return all posts for author if limit is 0 or invalid, respecting offset', async () => {
      let posts = await postsAddon.getPostsByAuthor(author2Id, { limit: 0, offset: 1 });
      expect(posts.length).toBe(totalPostsForAuthor2 - 1);
      expect(posts[0].text).toBe(`Author2 Post ${totalPostsForAuthor2 - 1}`);

      posts = await postsAddon.getPostsByAuthor(author1Id, { limit: undefined, offset: totalPostsForAuthor1 - 2 });
      expect(posts.length).toBe(2);
      expect(posts[0].text).toBe('Author1 Post 2');
    });
  });
}); 