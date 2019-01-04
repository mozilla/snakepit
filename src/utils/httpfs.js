const fs = require('fs')
const path = require('path')
const BufferSerializer = require('buffer-serializer')

const argCount = {
    getattr:  0,
    readdir:  0,
    truncate: 1,
    readlink: 0,
    chown:    2,
    chmod:    1,
    read:     2,
    write:    2,
    create:   1,
    utimens:  2,
    unlink:   0,
    rename:   1,
    link:     1,
    symlink:  1,
    mkdir:    1,
    rmdir:    0
}

const unixCodes = {
    EPERM: -1,
    ENOENT: -2,
    ESRCH: -3,
    EINTR: -4,
    EIO: -5,
    ENXIO: -6,
    E2BIG: -7,
    ENOEXEC: -8,
    EBADF: -9,
    ECHILD: -10,
    EAGAIN: -11,
    ENOMEM: -12,
    EACCES: -13,
    EFAULT: -14,
    ENOTBLK: -15,
    EBUSY: -16,
    EEXIST: -17,
    EXDEV: -18,
    ENODEV: -19,
    ENOTDIR: -20,
    EISDIR: -21,
    EINVAL: -22,
    ENFILE: -23,
    EMFILE: -24,
    ENOTTY: -25,
    ETXTBSY: -26,
    EFBIG: -27,
    ENOSPC: -28,
    ESPIPE: -29,
    EROFS: -30,
    EMLINK: -31,
    EPIPE: -32,
    EDOM: -33,
    ERANGE: -34,
    EDEADLK: -35,
    ENAMETOOLONG: -36,
    ENOLCK: -37,
    ENOSYS: -38,
    ENOTEMPTY: -39,
    ELOOP: -40,
    EWOULDBLOCK: -11,
    ENOMSG: -42,
    EIDRM: -43,
    ECHRNG: -44,
    EL2NSYNC: -45,
    EL3HLT: -46,
    EL3RST: -47,
    ELNRNG: -48,
    EUNATCH: -49,
    ENOCSI: -50,
    EL2HLT: -51,
    EBADE: -52,
    EBADR: -53,
    EXFULL: -54,
    ENOANO: -55,
    EBADRQC: -56,
    EBADSLT: -57,
    EDEADLOCK: -35,
    EBFONT: -59,
    ENOSTR: -60,
    ENODATA: -61,
    ETIME: -62,
    ENOSR: -63,
    ENONET: -64,
    ENOPKG: -65,
    EREMOTE: -66,
    ENOLINK: -67,
    EADV: -68,
    ESRMNT: -69,
    ECOMM: -70,
    EPROTO: -71,
    EMULTIHOP: -72,
    EDOTDOT: -73,
    EBADMSG: -74,
    EOVERFLOW: -75,
    ENOTUNIQ: -76,
    EBADFD: -77,
    EREMCHG: -78,
    ELIBACC: -79,
    ELIBBAD: -80,
    ELIBSCN: -81,
    ELIBMAX: -82,
    ELIBEXEC: -83,
    EILSEQ: -84,
    ERESTART: -85,
    ESTRPIPE: -86,
    EUSERS: -87,
    ENOTSOCK: -88,
    EDESTADDRREQ: -89,
    EMSGSIZE: -90,
    EPROTOTYPE: -91,
    ENOPROTOOPT: -92,
    EPROTONOSUPPORT: -93,
    ESOCKTNOSUPPORT: -94,
    EOPNOTSUPP: -95,
    EPFNOSUPPORT: -96,
    EAFNOSUPPORT: -97,
    EADDRINUSE: -98,
    EADDRNOTAVAIL: -99,
    ENETDOWN: -100,
    ENETUNREACH: -101,
    ENETRESET: -102,
    ECONNABORTED: -103,
    ECONNRESET: -104,
    ENOBUFS: -105,
    EISCONN: -106,
    ENOTCONN: -107,
    ESHUTDOWN: -108,
    ETOOMANYREFS: -109,
    ETIMEDOUT: -110,
    ECONNREFUSED: -111,
    EHOSTDOWN: -112,
    EHOSTUNREACH: -113,
    EALREADY: -114,
    EINPROGRESS: -115,
    ESTALE: -116,
    EUCLEAN: -117,
    ENOTNAM: -118,
    ENAVAIL: -119,
    EISNAM: -120,
    EREMOTEIO: -121,
    EDQUOT: -122,
    ENOMEDIUM: -123,
    EMEDIUMTYPE: -124
}

const uid = process.getuid ? process.getuid() : 0
const gid = process.getgid ? process.getgid() : 0
const stdDate = new Date()
const selfReadWriteMask = parseInt("600", 8)
const dirAttributes = {
    mtime:  stdDate,
    atime:  stdDate,
    ctime:  stdDate,
    nlink:  1,
    size:   100,
    mode:   16877,
    uid:    uid,
    gid:    gid
}

var serializer = new BufferSerializer()

var exports = module.exports = {}

exports.real = function (basePath) {
    let getRealPath = (pathItems, cb, cont) => {
        let newPath = pathItems.length > 0 ? path.resolve(basePath, path.join(basePath, ...pathItems)) : basePath
        if (newPath.startsWith(basePath)) {
            cont(newPath)
        } else {
            cb(unixCodes.EACCES)
        }
    }
    return {
        destpath:   (pathItems, cb)                              => getRealPath(pathItems, cb,
            realPath => cb(0, realPath)
        ),
        getattr:    (pathItems, cb)                              => getRealPath(pathItems, cb,
            realPath => fs.lstat(realPath,        
                (err, stats) => err ? cb(err.errno || unixCodes.ENOENT) : cb(0, {
                    mtime: stats.mtime,
                    atime: stats.atime,
                    ctime: stats.ctime,
                    nlink: stats.nlink,
                    size:  stats.size,
                    mode:  stats.mode,
                    uid:   uid,
                    gid:   gid
                })
            )
        ),
        readdir:    (pathItems, cb)                              => getRealPath(pathItems, cb,
            realPath => fs.readdir(realPath,        
                (err, files) => err ? cb(err.errno || unixCodes.ENOENT) : cb(0, files)
            )
        ),
        truncate:   (pathItems, size, cb)                        => getRealPath(pathItems, cb,
            realPath => fs.truncate(realPath, size,  
                (err) => cb(err ? (err.errno || unixCodes.ENOENT) : 0)
            )
        ),
        readlink:   (pathItems, cb)                              => getRealPath(pathItems, cb,
            realPath => fs.readlink(realPath,        
                (err, link) => err ? cb(err.errno || unixCodes.ENOENT) : cb(null, link)
            )
        ),
        chown:      (pathItems, uid, gid, cb)                    => getRealPath(pathItems, cb,
            realPath => fs.chown(realPath, uid, gid, 
                (err) => cb(err ? (err.errno || unixCodes.ENOENT) : 0)
            )
        ),
        chmod:      (pathItems, mode, cb)                        => getRealPath(pathItems, cb,
            realPath => fs.chmod(realPath, mode,     
                (err) => cb(err ? (err.errno || unixCodes.ENOENT) : 0)
            )
        ),
        read:       (pathItems, offset, length, cb)              => getRealPath(pathItems, cb,
            realPath => {
                let buffer = Buffer.alloc(length)
                fs.open(realPath, 'r', (err, fd) => {
                    if (err) {
                        cb(err.errno || unixCodes.ENOENT)
                    } else {
                        fs.read(fd, buffer, 0, length, offset, 
                            (err, numw) => {
                                if (err) {
                                    cb(err.errno || unixCodes.ENOENT)
                                } else {
                                    fs.close(fd, err => err ? cb(err.errno || unixCodes.ENOENT) : cb(numw, buffer.slice(0, numw)))
                                }
                            }
                        )
                    }
                })
            }
        ),
        write:      (pathItems, buffer, offset, cb)  => getRealPath(pathItems, cb,
            realPath => {
                fs.open(realPath, 'a', (err, fd) => {
                    if (err) {
                        cb(err.errno || unixCodes.ENOENT)
                    } else {
                        fs.write(fd, buffer, 0, buffer.length, offset, 
                            (err, numw) => {
                                if (err) {
                                    cb(err.errno || unixCodes.ENOENT)
                                } else {
                                    fs.close(fd, err => cb(err ? (err.errno || unixCodes.ENOENT) : numw))
                                }
                            }
                        )
                    }
                })
            }
        ),
        create:     (pathItems, mode, cb)                        => getRealPath(pathItems, cb,
            realPath => fs.open(realPath, 'w', mode | selfReadWriteMask, (err, fd) => {
                if (err) {
                    cb(err.errno || unixCodes.ENOENT)
                } else {
                    fs.close(fd, err => cb(err ? (err.errno || unixCodes.ENOENT) : 0))
                }
            })
        ),
        utimens:    (pathItems, atime, mtime, cb)                => getRealPath(pathItems, cb,
            realPath => fs.utimes(realPath, atime, mtime,     
                (err) => cb(err ? (err.errno || unixCodes.ENOENT) : 0)
            )
        ),
        unlink:     (pathItems, cb)                              => getRealPath(pathItems, cb,
            realPath => fs.unlink(realPath,     
                (err) => cb(err ? (err.errno || unixCodes.ENOENT) : 0)
            )
        ),
        rename:     (pathItems, destPath, cb)                   => getRealPath(pathItems, cb,
            realPath => {
                fs.rename(realPath, destPath,
                    (err) => cb(err ? (err.errno || unixCodes.ENOENT) : 0)
                )
            }
        ),
        link:    (pathItems, dest, cb)                           => getRealPath(pathItems, cb,
            realPath => fs.link(dest, realPath, 
                (err) => cb(err ? (err.errno || unixCodes.ENOENT) : 0)
            )
        ),
        symlink:    (pathItems, dest, cb)                        => getRealPath(pathItems, cb,
            realPath => fs.symlink(dest, realPath, 
                (err) => cb(err ? (err.errno || unixCodes.ENOENT) : 0)
            )
        ),
        mkdir:      (pathItems, mode, cb)                        => getRealPath(pathItems, cb,
            realPath => fs.mkdir(realPath, mode,    
                (err) => cb(err ? (err.errno || unixCodes.ENOENT) : 0)
            )
        ),
        rmdir:      (pathItems, cb)                              => getRealPath(pathItems, cb,
            realPath => fs.rmdir(realPath, 
                (err) => cb(err ? (err.errno || unixCodes.ENOENT) : 0)
            )
        )

    }
}

exports.readOnly = function (other) {
    return {
        getattr:    (pathItems, cb) => other.getattr(pathItems, (code, attr) => {
            if (code === 0) {
                attr.mode = attr.mode & 0xffffff6d
                cb(0, attr)
            } else {
                cb(code)
            }
        }),
        readdir:    other.readdir,
        read:       other.read
    }
}

exports.vFile = function (buffer) {
    return {
        getattr: (pathItems, cb) => cb(0, {
            mtime:  stdDate,
            atime:  stdDate,
            ctime:  stdDate,
            nlink:  1,
            size:   buffer.length,
            mode:   33188,
            uid:    uid,
            gid:    gid
        }),
        read: (pathItems, offset, length, cb) => {
            let nb = buffer.slice(offset, offset + length)
            cb(nb.length, nb)
        }
    }
}

exports.vDir = function (entries, entry) {
    let dirOperations = {
        getattr: (pathItems, cb) => cb(0, dirAttributes),
        readdir: (pathItems, cb) => cb(0, typeof entries === 'function' ? entries() : Object.keys(entries))
    }
    return new Proxy({}, {
        get: (target, operation, receiver) => function () {
            let args = Array.from(arguments)
            let pathItems = args[0]
            let cb = args[args.length - 1]
            if (!cb || typeof cb !== 'function') {
                return
            }
            let operations = dirOperations
            if (pathItems.length > 0) {
                let item = pathItems.shift()
                operations = typeof entry === 'function' ? entry(item) : entries[item]
                if (typeof operations === 'function') {
                    operations = operations()
                }
            }
            if (operations) {
                let operationFunction = operations[operation]
                if (operationFunction) {
                    operationFunction(...args)
                } else {
                    cb(unixCodes.EACCES)
                }
            } else {
                cb(unixCodes.EACCES)
            }
        }
    })
}

let isBuffer = obj => obj != null && obj.constructor != null && obj.constructor.isBuffer

exports.serve = function (root, call, cb, debug) {
    let debugOps = {}
    if (typeof debug === 'string') {
        for(let op of debug.toLowerCase().split(',')) {
            debugOps[op] = true
        }
    }
    let cargs
    let wrap = (...args) => {
        if (debugOps['all'] || debugOps[call.operation] || (args.length > 0 && args[0] < 0 && call.operation != 'getattr')) {
            console.log(call.operation, cargs, args.filter(obj => !isBuffer(obj)))
        }
        cb(serializer.toBuffer(args))
    }
    if (!root) {
        return wrap(unixCodes.ENOENT)
    }
    try {
        call = serializer.fromBuffer(call)
    } catch (ex) {
        return wrap(unixCodes.ENOENT)
    }
    cargs = call.args.filter(obj => !isBuffer(obj))
    let operation = root[call.operation]
    if (operation) {
        if (call.args.length > 0) {
            let shiftItems = () => call.args.shift().split('/').filter(v => v.length > 0)
            let pathItems = shiftItems()
            if (call.args.length === argCount[call.operation]) {
                if (call.operation === 'rename') {
                    if (call.args.length > 0) {
                        let destItems = shiftItems()
                        let destpath = root['destpath']
                        if (destpath) {
                            destpath(destItems, (code, destPath) => {
                                if (code == 0) {
                                    operation(pathItems, destPath, ...call.args, wrap)
                                } else {
                                    wrap(code)
                                }
                            })
                        } else {
                            wrap(unixCodes.EACCES)
                        }
                    } else {
                        wrap(unixCodes.ENOENT)
                    }
                } else {
                    operation(pathItems, ...call.args, wrap)
                }
            } else {
                wrap(unixCodes.EPROTO)
            }
        } else {
            wrap(unixCodes.ENOENT)
        }
    } else {
        console.log(call.operation, false)
        wrap(unixCodes.EACCES)
    }
}
