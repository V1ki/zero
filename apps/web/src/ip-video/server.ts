import { Hono } from 'hono'
import { createIPVideoRoutes } from './api'
import { ProjectStore } from './store'

const store = new ProjectStore()
store.recover()
const app = new Hono().route('/api/ip-video', createIPVideoRoutes(store))
const server = Bun.serve({ hostname: '127.0.0.1', port: 14433, fetch: app.fetch, idleTimeout: 255 })
console.log(`IP video API ready: ${server.url}api/ip-video/health; data: ${store.root}`)
