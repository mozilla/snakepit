const fs = require('fs')
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
        const url = require('url')
        const http = require('http')
        const https = require('https')
        const morgan = require('morgan')
        const express = require('express')
        const bodyParser = require('body-parser')

        let app = express()
        app.use(bodyParser.json({ limit: '50mb' }))
        app.use(bodyParser.urlencoded({ extended: false }))
        app.use(morgan('combined', {
            skip: function (req, res) { return res.statusCode < 400 }
        }))
        
        modules.forEach(module => (module.initApp || Function)(app))

        app.use(function (err, req, res, next) {
            console.error(err.stack)
            res.status(500).send('Something broke')
        })

        let inter = process.env.SNAKEPIT_INTERFACE || config.interface || '0.0.0.0'
        let port = process.env.SNAKEPIT_PORT || config.port
        if (config.key && config.cert) {
            port = port || 443
            https.createServer({ key: config.key, cert: config.cert }, app).listen(port, inter)
        } else {
            port = port || 80
            http.createServer(app).listen(port, inter)
        }
        console.log('Snakepit service running on port ' + port)
    } catch (ex) {
        console.error('Failure during startup: ' + ex)
        process.exit(100)
    }
}
