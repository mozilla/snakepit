const Router = require('express-promise-router')

const config = require('../config.js')
const fslib = require('../utils/httpfs.js')
const { ensureSignedIn, ensureAdmin } = require('./users.js')

const router = module.exports = new Router()

router.use(ensureSignedIn)

router.get('/', async (req, res) => {
    res.send((await Group.findAll()).map(group => group.id))
})

router.use(ensureAdmin)

router.put('/:id', async (req, res) => {
    if (req.body && req.body.title) {
        await Group.create({
            id:   req.params.id,
            title: req.body.title
        })
        res.send()
    } else {
        res.status(400).send()
    }
})

function targetGroup (req, res, next) {
    req.targetGroup = Group.findById(req.params.id)
    req.targetGroup ? next() : res.status(404).send()
}

router.use(targetGroup)

router.delete('/:id', async (req, res) => {
    await req.targetGroup.destroy()
    res.send()
})

router.post('/:id/fs', async (req, res) => {
    if (await req.user.hasGroup(req.targetGroup)) {
        let chunks = []
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => fslib.serve(
            fslib.real(req.targetGroup.getGroupDir()), 
            Buffer.concat(chunks), 
            result => res.send(result), config.debugJobFS)
        )
    } else {
        res.status(403).send()
    }
})
