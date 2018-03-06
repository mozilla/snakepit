const fs = require('fs')
const path = require('path')
const cluster = require('cluster')
const cpus = require('os').cpus().length
const modules = 'user node job'.split(' ').map(name => require('./' + name + '.js'))

function readConfigFile(name) {
    var filename = path.join('config', name)
    return content = fs.readFileSync(filename, 'utf8')
}

if (cluster.isMaster) {
    for (var i = 0; i < cpus; i++)
        cluster.fork()
    cluster.on('exit', function(deadWorker, code, signal) {
        if (code === 100) {
            process.exit(100) // Preventing fork-loop on startup problems
        }
        var worker = cluster.fork();
        console.log('Worker ' + deadWorker.process.pid + ' died.');
        console.log('Worker ' + worker.process.pid + ' born.');
    })
    modules.forEach(module => module.initDb())
} else {
    try {
        const url = require('url')
        const https = require('https')
        const express = require('express')
        const morgan = require('morgan')
        const bodyParser = require('body-parser')

        const config = JSON.parse(readConfigFile('snakepit.config'))

        var app = express()
        app.set('tokenSecret', readConfigFile('token-secret.txt'))
        app.set('config', config)
        app.use(bodyParser.urlencoded({ extended: false }))
        app.use(bodyParser.json())
        app.use(morgan('dev'))

        modules.forEach(module => module.initApp(app))

        var credentials = {
            key: readConfigFile('key.pem'),
            cert: readConfigFile('cert.pem')
        }
        var httpsServer = https.createServer(credentials, app)
        var port = process.env.SNAKEPIT_PORT || config.port || 1443
        httpsServer.listen(port)
        console.log('Snakepit service running on port ' + port)
    } catch (ex) {
        console.error('Failure during startup: ' + ex)
        process.exit(100)
    }
}
