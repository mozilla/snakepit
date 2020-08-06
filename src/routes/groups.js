const Router = require('express-promise-router')
const clusterEvents = require('../utils/clusterEvents.js')
const config = require('../config.js')
const simplefs = require('../utils/simplefs.js')
const Group = require('../models/Group-model.js')
const { ensureSignedIn, ensureAdmin, tryTargetGroup, targetGroup, memberOrAdmin } = require('./mw.js')

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

router.all('/:group/simplefs/' + simplefs.pattern, targetGroup, memberOrAdmin, async (req, res) => {
    let baseDir = Group.getDir(req.targetGroup.id)
    await simplefs.performCommand(baseDir, req, res)
})

router.use(ensureAdmin)

router.put('/:group', tryTargetGroup, async (req, res) => {
    if (req.targetGroup) {
        return Promise.reject({ code: 403, message: 'Group already existing' })
    }
    if (req.body && req.body.title) {
        await Group.create({
            id:   req.params.group,
            title: req.body.title
        })
        res.send()
    } else {
        res.status(400).send()
    }
})

router.post('/:group', targetGroup, async (req, res) => {
    if (req.body && req.body.title) {
        req.targetGroup.title = req.body.title
        await req.targetGroup.save()
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
