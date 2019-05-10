const fs = require('fs')
const net = require('net')
const multiplex = require('multiplex')

const mp = multiplex((stream, id) => {
    let port = Number(id.split('-')[1])
    let client = net.createConnection({ port: port }, () => {
        stream.pipe(client)
        client.pipe(stream)
    })
    client.on('error', err => stream.destroy(err))
})

process.stdin.pipe(mp)
mp.pipe(process.stdout)