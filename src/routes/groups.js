const Router = require('express-promise-router')
const clusterEvents = require('../utils/clusterEvents.js')
const config = require('../config.js')
const fslib = require('../utils/httpfs.js')
const Group = require('../models/Group-model.js')
const { ensureSignedIn, ensureAdmin, tryTargetGroup, targetGroup } = require('./mw.js')

const router = module.exports = new Router()

router.use(ensureSignedIn)

router.get('/', async (req, res) => {
    res.send((await Group.findAll()).map(group => group.id))
})

router.get('/:group', targetGroup, async (req, res) => {
    res.send({
        id:     req.targetGroup.id,
        title:  req.targetGroup.title
    })
})

router.post('/:group/fs', targetGroup, async (req, res) => {
    if (req.user.admin || await req.user.isMemberOf(req.targetGroup)) {
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

router.put('/:group', tryTargetGroup, async (req, res) => {
    if (req.body && req.body.title) {
        if (req.targetGroup) {
            req.targetGroup.title = req.body.title
            await req.targetGroup.save()
        } else {
            await Group.create({
                id:   req.params.group,
                title: req.body.title
            })
        }
        res.send()
    } else {
        res.status(400).send()
    }
})

router.delete('/:group', targetGroup, async (req, res) => {
    await req.targetGroup.destroy()
    res.send()
    clusterEvents.emit('restricted')
})
