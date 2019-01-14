const cluster = require('cluster')
const cpus = require('os').cpus().length
const log = require('./utils/logger.js')
const config = require('./config.js')
const models = require('./models')
const pitRunner = require('./pitRunner.js')
const scheduler = require('./scheduler.js')

if (cluster.isMaster) {
    models.sequelize.sync()
    models.all.forEach(model => (model.startup || Function)())
    pitRunner.tick()
    scheduler.tick()
    cluster.on('exit', function(deadWorker, code, signal) {
        if (code === 100) {
            process.exit(100) // Preventing fork-loop on startup problems
        }
        var worker = cluster.fork();
        log.error('Worker ' + deadWorker.process.pid + ' died.')
        log.info('Worker ' + worker.process.pid + ' born.')
    })
    for (let i = 0; i < cpus; i++) {
        cluster.fork()
    }
    log.error('Snakepit daemon started')
} else {
    try {
        const http = require('http')
        const morgan = require('morgan')
        const express = require('express')
        const bodyParser = require('body-parser')

        let app = express()
        app.use(bodyParser.json({ limit: '50mb' }))
        app.use(morgan('combined', {
            skip: (req, res) => false //res.statusCode < 400 && !config.debugHttp
        }))
        
        app.use(require('./routes'))

        app.use((err, req, res, next) => {
            log.error(err, err.stack)
            res.status(500).send()
        })

        http.createServer(app).listen(config.port, config.interface)
        log.info('Snakepit service running on ' + config.interface + ':' + config.port)
    } catch (ex) {
        log.error('Failure during startup: ', ex, ex.stack)
        
        process.exit(100)
    }
}
