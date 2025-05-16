import { createLibp2p } from 'libp2p'
import { webSockets } from '@libp2p/websockets'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { bootstrap } from '@libp2p/bootstrap'

// Known peers addresses
const bootstrapMultiaddrs = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN'
]

const node = await createLibp2p({
  // libp2p nodes are started by default
  addresses: {
    listen: ['/ip4/127.0.0.1/tcp/0/ws'] // Use 0 para uma porta aleatória
  },
  transports: [webSockets()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  peerDiscovery: [
    bootstrap({
      list: bootstrapMultiaddrs, // provide array of multiaddrs
    })
  ]
})

node.addEventListener('peer:discovery', (evt) => {
  console.log('Discovered %s', evt.detail.id.toString()) // Log discovered peer
})

node.addEventListener('peer:connect', (evt) => {
  console.log('Connected to %s', evt.detail.toString()) // Log connected peer
})

// Manter o nó rodando por um tempo para permitir a descoberta de peers
console.log('Libp2p node is running. Listening on:')
node.getMultiaddrs().forEach((ma) => console.log(ma.toString()))

// Parar o nó após 30 segundos (para demonstração)
setTimeout(async () => {
  await node.stop()
  console.log('Libp2p node stopped')
}, 30000) 