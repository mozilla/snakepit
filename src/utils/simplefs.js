const fs = require('fs-extra')
const path = require('path')
const parseRange = require('range-parser')
const { to } = require('./async.js')
const log = require('./logger.js')

var exports = module.exports = {}

exports.pattern = ':aspect/(*)?'

async function performCommand (basePath, req, res, readOnly) {
    let targetPath = path.resolve(basePath, req.params[0] || '')
    let aspect = req.params.aspect
    if (!targetPath.startsWith(basePath)) {
        return res.status(404).send()
    }
    let [statsErr, stats] = await to(fs.stat(targetPath))
    if (req.method === "GET") {
        if (statsErr || !(stats.isDirectory() || stats.isFile())) {
            res.status(404).send()
        } else if (aspect === 'stats') {
            res.send({
                isFile: stats.isFile(),
                size:   stats.size,
                mtime:  stats.mtime,
                atime:  stats.atime,
                ctime:  stats.ctime
            })
        } else if (aspect === 'content') {
            if (stats.isDirectory()) {
                let dirs = []
                let files = []
                let names = await fs.readdir(targetPath)
                const promises = names.map(async entry => {
                    let ePath = path.join(targetPath, entry)
                    let eStat = await fs.stat(ePath)
                    return {
                        name: entry,
                        isFile: eStat.isFile(),
                        isDirectory: eStat.isDirectory()
                    }
                })
                let dirents = await Promise.all(promises)
                for (let dirent of dirents) {
                    if (dirent.isFile) {
                        files.push(dirent.name)
                    } else if (dirent.isDirectory) {
                        dirs.push(dirent.name)
                    }
                }
                res.send({dirs: dirs, files: files})
            } else {
                if (req.headers.range) {
                    let ranges = parseRange(stats.size, req.headers.range)
                    if (Array.isArray(ranges)) {
                        if (ranges.type !== 'bytes' || ranges.length !== 1) {
                            res.status(416).send()
                        } else {
                            let range = ranges[0]
                            res.writeHead(206, {
                                'Content-Type': 'application/octet-stream',
                                'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + stats.size,
                                'Content-Length': '' + (range.end - range.start + 1)
                            })
                            fs.createReadStream(
                                targetPath,
                                {start: range.start, end: range.end}
                            ).pipe(res)
                        }
                    } else if (ranges === -1) {
                        res.status(416).send()
                    } else {
                        res.status(400).send()
                    }
                } else {
                    res.writeHead(200, {
                        'Content-Type': 'application/octet-stream',
                        'Content-Length': stats.size
                    })
                    fs.createReadStream(targetPath).pipe(res)
                }
            }
        } else {
            res.status(400).send()
        }
    } else if (req.method === "PUT" && !readOnly) {
        if (aspect === 'stats' && req.body && req.body.type) {
            let newSize = Number(req.body.size) || 0
            if (statsErr) {
                if (req.body.type === 'file') {
                    let file
                    try {
                        file = await fs.open(targetPath, 'w')
                        await fs.ftruncate(file, newSize)
                    } catch (err) {
                        if (err.code === 'ENOENT') {
                            res.status(404)
                        } else {
                            throw err
                        }
                    } finally {
                        if (file) {
                            await fs.close(file)
                        }
                        res.send()
                    }
                } else if (req.body.type === 'directory') {
                    await fs.ensureDir(targetPath)
                    res.send()
                } else {
                    res.status(400).send()
                }
            } else {
                if (req.body.type === 'file' && stats.isFile()) {
                    await fs.truncate(targetPath, newSize)
                    res.send()
                } else {
                    res.status(400).send()
                }
            }
        } else if (aspect === 'content' && !statsErr && stats.isFile()) {
            let offset = Number(req.headers['content-offset']) || 0
            await fs.truncate(targetPath, offset)
            let target = fs.createWriteStream(targetPath, {flags: 'a'})
            await new Promise((resolve, reject) => {
                req.pipe(target)
                req.on('end', resolve)
                req.on('error', reject)
            })
            res.send()
        } else {
            res.status(400).send()
        }
    } else if (req.method === "DELETE" && !readOnly) {
        if (aspect === 'stats' && !statsErr && (stats.isDirectory() || stats.isFile())) {
            await fs.remove(targetPath)
            res.send()
        } else {
            res.status(404).send()
        }
    } else {
        res.status(403).send()
    }
}
exports.performCommand = performCommand



