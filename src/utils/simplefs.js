const fs = require('fs')
const path = require('path')
const ndir = require('node-dir')

var exports = module.exports = {}

exports.pattern = ':command/(*)?'

function performCommand (basePath, req, res, readOnly) {
    let targetPath = path.resolve(basePath, req.params[0] || '')
    if (!targetPath.startsWith(basePath)) {
        res.status(404).send()
    } else {
        if (req.method == "GET") {
            let command = req.params.command
            fs.stat(targetPath, (err, stats) => {
                if (err || !(stats.isDirectory() || stats.isFile())) {
                    res.status(404).send()
                } else if (command == 'stats') {
                    res.send({
                        isFile: stats.isFile(),
                        size:   stats.size,
                        mtime:  stats.mtime,
                        atime:  stats.atime,
                        ctime:  stats.ctime
                    })
                } else if (command == 'content') {
                    if (stats.isDirectory()) {
                        ndir.files(targetPath, 'all', (err, paths) => {
                            if (err) {
                                res.status(500).send()
                            } else {
                                res.send({ dirs: paths.dirs, files: paths.files })
                            }
                        }, { shortName: true, recursive: false })
                    } else {
                        res.writeHead(200, {
                            'Content-Type': 'application/octet-stream',
                            'Content-Length': stats.size
                        })
                        fs.createReadStream(targetPath).pipe(res)
                    }
                } else {
                    res.status(400).send()
                }
            })
        } else {
            res.status(404).send()
        }
    }
}
exports.performCommand = performCommand



