const fs = require('fs')
const cluster = require('cluster')
const morgan = require('morgan')
const db = require('./store.js').root
const cpus = require('os').cpus().length

const modules = 'user node'.split(' ').map(name => require('./' + name + '.js'))

function readConfigFile(name) {
    return fs.readFileSync('config/' + name, 'utf8')
}

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
    const bodyParser = require('body-parser')

    const config = JSON.parse(readConfigFile('snakepit.config'))

    var app = express()
    app.set('tokenSecret', readConfigFile('token-secret.txt'))
    app.set('config', config)
    app.use(bodyParser.urlencoded({ extended: false }))
    app.use(bodyParser.json())
    app.use(morgan('dev'))

    modules.forEach(module => module.initApp(app, db))

    var credentials = {
        key: readConfigFile('key.pem'),
        cert: readConfigFile('cert.pem')
    }
    var httpsServer = https.createServer(credentials, app)
    var port = process.env.SNAKEPIT_PORT || config.port || 1443
    httpsServer.listen(port)
    console.log('Snakepit service running on port ' + port)
}
