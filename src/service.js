const cluster = require('cluster')
const cpus = require('os').cpus().length
const config = require('./config.js')
const modules = 'jobfs users groups nodes jobs aliases'
    .split(' ').map(name => require('./' + name + '.js'))

if (cluster.isMaster) {
    modules.forEach(module => (module.initDb || Function)())
    modules.forEach(module => (module.tick || Function)())
    for (var i = 0; i < cpus; i++)
        cluster.fork()
    cluster.on('exit', function(deadWorker, code, signal) {
        if (code === 100) {
            process.exit(100) // Preventing fork-loop on startup problems
        }
        var worker = cluster.fork();
        console.log('Worker ' + deadWorker.process.pid + ' died.')
        console.log('Worker ' + worker.process.pid + ' born.')
    })
} else {
    try {
        const http = require('http')
        const https = require('https')
        const morgan = require('morgan')
        const express = require('express')
        const bodyParser = require('body-parser')

        let app = express()
        app.use(bodyParser.json({ limit: '50mb' }))
        app.use(morgan('combined', {
            skip: (req, res) => res.statusCode < 400 && !config.debugHttp
        }))
        
        modules.forEach(module => (module.initApp || Function)(app))

        app.use(function (err, req, res, next) {
            console.error(err.stack)
            res.status(500).send('Something broke')
        })

        if (config.https) {
            https.createServer({ key: config.key, cert: config.cert }, app).listen(config.port, config.interface)
        } else {
            http.createServer(app).listen(config.port, config.interface)
        }
        console.log('Snakepit service running on ' + config.interface + ':' + config.port)
    } catch (ex) {
        console.error('Failure during startup: ' + ex)
        process.exit(100)
    }
}
