const Router = require('express-promise-router')

const clusterEvents = require('../utils/clusterEvents.js')
const config = require('../config.js')
const fslib = require('../utils/httpfs.js')
const { ensureSignedIn, ensureAdmin } = require('./users.js')
const Group = require('../models/Group-model.js')

const router = module.exports = new Router()

router.use(ensureSignedIn)

router.get('/', async (req, res) => {
    res.send((await Group.findAll()).map(group => group.id))
})

function targetGroup (req, res, next) {
    Group.findByPk(req.params.id).then(group => {
        if (group) {
            req.targetGroup = group
            next()
        } else {
            res.status(404).send()
        }
    })
}

router.get('/:id', targetGroup, async (req, res) => {
    res.send({
        id:     req.targetGroup.id,
        title:  req.targetGroup.title
    })
})

router.post('/:id/fs', targetGroup, async (req, res) => {
    if (req.user.admin || await req.user.hasGroup(req.targetGroup)) {
        let chunks = []
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => fslib.serve(
            fslib.real(req.targetGroup.getDir()), 
            Buffer.concat(chunks), 
            result => res.send(result), config.debugJobFS)
        )
    } else {
        res.status(403).send()
    }
})

router.use(ensureAdmin)

router.put('/:id', async (req, res) => {
    if (req.body && req.body.title) {
        let group = await Group.findByPk(req.params.id)
        if (group) {
            group.title = req.body.title
            await group.save()
        } else {
            await Group.create({
                id:   req.params.id,
                title: req.body.title
            })
        }
        res.send()
    } else {
        res.status(400).send()
    }
})

router.delete('/:id', targetGroup, async (req, res) => {
    await req.targetGroup.destroy()
    res.send()
    clusterEvents.emit('restricted')
})
