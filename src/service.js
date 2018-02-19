const cluster = require('cluster')
const db = require('./store.js').root
const cpus = require('os').cpus().length

const modules = 'user node'.split(' ').map(name => require('./' + name + '.js'))

if (cluster.isMaster) {
    for (var i = 0; i < cpus; i++)
        cluster.fork()
    modules.forEach(module => module.initDb(db))
} else {
    const fs = require('fs')
    const url = require('url')
    const http = require('http')
    const https = require('https')
    const express = require('express')

    var privateKey  = fs.readFileSync('connect/key.pem', 'utf8')
    var certificate = fs.readFileSync('connect/cert.pem', 'utf8')
    var credentials = { key: privateKey, cert: certificate }

    var app = express()
    modules.forEach(module => module.initApp(app, db))

    var httpsServer = https.createServer(credentials, app)
    var configPort = url.parse(fs.readFileSync('connect/.pitconnect.txt', 'utf-8').split('\n')[0]).port
    var port = process.env.SNAKEPIT_PORT || configPort || 1443
    httpsServer.listen(port)
    console.log('Snakepit service running on port ' + port)
}
