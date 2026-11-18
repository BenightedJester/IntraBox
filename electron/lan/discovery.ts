import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import type { PeerInfo } from '../../src/shared/lan-types'
import { broadcastOf, lanIfaces, lanIPv4s } from './fs-utils'

const GROUP = '239.255.77.88'
const BEACON_PORT = 41777
const HELLO_INTERVAL = 3000
const PEER_TTL = 12000

interface Beacon {
  app: 'intrabox'
  t: 'hello' | 'bye'
  v: number
  id: string
  name: string
  port: number
}

/**
 * 局域网设备发现：UDP 组播 + 广播双通道信标。
 * 每 3 秒广播一次自身信息；12 秒未收到信标判定离线。
 */
export class Discovery extends EventEmitter {
  private socket: dgram.Socket | null = null
  private helloTimer: NodeJS.Timeout | null = null
  private pruneTimer: NodeJS.Timeout | null = null
  private peers = new Map<string, PeerInfo>()
  private selfId: string
  private selfName: string
  private httpPort: number

  constructor(selfId: string, selfName: string, httpPort: number) {
    super()
    this.selfId = selfId
    this.selfName = selfName
    this.httpPort = httpPort
  }

  setSelf(name: string, port: number) {
    this.selfName = name
    this.httpPort = port
  }

  list(): PeerInfo[] {
    return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  get(id: string): PeerInfo | undefined {
    return this.peers.get(id)
  }

  /** 收到聊天消息时也可即时登记对方，避免等待信标 */
  upsertFromMessage(id: string, name: string, ip: string, port: number) {
    if (!id || id === this.selfId) return
    const prev = this.peers.get(id)
    const peer: PeerInfo = { id, name, ip, port, lastSeen: Date.now() }
    this.peers.set(id, peer)
    if (!prev || prev.name !== name || prev.ip !== ip || prev.port !== port) {
      this.emit('peers', this.list())
    }
  }

  start() {
    if (this.socket) return
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket

    socket.on('error', (err) => {
      console.error('[discovery] socket 错误', err)
    })

    socket.on('message', (buf, rinfo) => {
      let msg: Beacon
      try {
        msg = JSON.parse(buf.toString('utf-8'))
      } catch {
        return
      }
      if (msg.app !== 'intrabox' || msg.id === this.selfId) return
      if (msg.t === 'bye') {
        if (this.peers.delete(msg.id)) this.emit('peers', this.list())
        return
      }
      if (msg.t !== 'hello' || typeof msg.port !== 'number') return
      const prev = this.peers.get(msg.id)
      const peer: PeerInfo = {
        id: msg.id,
        name: String(msg.name || msg.id.slice(0, 8)),
        ip: rinfo.address,
        port: msg.port,
        lastSeen: Date.now(),
      }
      this.peers.set(msg.id, peer)
      if (!prev || prev.name !== peer.name || prev.ip !== peer.ip || prev.port !== peer.port) {
        this.emit('peers', this.list())
      }
    })

    socket.bind(BEACON_PORT, () => {
      try {
        socket.setBroadcast(true)
        socket.setMulticastTTL(2)
        socket.setMulticastLoopback(true)
      } catch {
        /* 部分环境不支持 */
      }
      for (const ip of lanIPv4s()) {
        try {
          socket.addMembership(GROUP, ip)
        } catch {
          /* 个别网卡加入组播失败可忽略，仍有广播兜底 */
        }
      }
      try {
        socket.addMembership(GROUP)
      } catch {
        /* 默认接口已加入时会抛错，忽略 */
      }
      // 启动即发，随后 500ms 补发一次，加快互相发现
      this.sendHello()
      setTimeout(() => this.sendHello(), 500)
    })

    this.helloTimer = setInterval(() => this.sendHello(), HELLO_INTERVAL)
    this.pruneTimer = setInterval(() => {
      const now = Date.now()
      let changed = false
      for (const [id, peer] of this.peers) {
        if (now - peer.lastSeen > PEER_TTL) {
          this.peers.delete(id)
          changed = true
        }
      }
      if (changed) this.emit('peers', this.list())
    }, 3000)
  }

  private sendHello() {
    if (!this.socket) return
    const packet: Beacon = {
      app: 'intrabox',
      t: 'hello',
      v: 1,
      id: this.selfId,
      name: this.selfName,
      port: this.httpPort,
    }
    this.sendPacket(Buffer.from(JSON.stringify(packet), 'utf-8'))
  }

  /**
   * 逐网卡显式发送：组播指定出口接口 + 子网定向广播。
   * 不依赖系统默认组播/广播选路，避免被 WSL/VMware 等低 metric 虚拟网卡截胡。
   * 注：Windows 下 setMulticastInterface 可能不生效，子网定向广播是可靠通道。
   */
  private sendPacket(buf: Buffer) {
    if (!this.socket) return
    for (const iface of lanIfaces()) {
      try {
        this.socket.setMulticastInterface(iface.address)
        this.socket.send(buf, 0, buf.length, BEACON_PORT, GROUP)
      } catch {
        /* 个别网卡不支持组播，忽略 */
      }
      const bcast = broadcastOf(iface.address, iface.netmask)
      if (bcast) {
        try {
          this.socket.send(buf, 0, buf.length, BEACON_PORT, bcast)
        } catch {
          /* 广播在部分网络不可用 */
        }
      }
    }
    // 全局广播兜底（单网卡环境下与逐网卡发送等效）
    try {
      this.socket.send(buf, 0, buf.length, BEACON_PORT, '255.255.255.255')
    } catch {
      /* 忽略 */
    }
  }

  stop() {
    if (this.helloTimer) clearInterval(this.helloTimer)
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    this.helloTimer = null
    this.pruneTimer = null
    if (this.socket) {
      const bye = Buffer.from(
        JSON.stringify({ app: 'intrabox', t: 'bye', v: 1, id: this.selfId, name: this.selfName, port: this.httpPort }),
        'utf-8',
      )
      this.sendPacket(bye)
      try {
        this.socket.close()
      } catch {
        /* 忽略 */
      }
      this.socket = null
    }
    this.peers.clear()
    this.emit('peers', this.list())
  }
}