
const models = require('./models')
const fs = require('fs-extra')
const { MultiRange } = require('multi-integer-range')

function summarizeReservation (clusterReservation) {
    try {
        let nodes = {}
        for (let groupReservation of clusterReservation) {
            for (let processReservation of groupReservation) {
                nodes[processReservation.node] =
                    Object.assign(
                        nodes[processReservation.node] || {},
                        processReservation.resources
                    )
            }
        }
        let summary = ''
        for (let nodeId of Object.keys(nodes)) {
            let nodeResources = nodes[nodeId]
            if (summary != '') {
                summary += ' + '
            }
            summary += nodeId + '['
            let first = true
            for (let type of
                Object.keys(nodeResources)
                    .map(r => nodeResources[r].type)
                    .filter(v => !v.startsWith('num:'))
                    .filter((v, i, a) => a.indexOf(v) === i) // make unique
                ) {
                let resourceIndices =
                    Object.keys(nodeResources)
                        .map(r => nodeResources[r])
                        .filter(r => r.type == type)
                        .map(r => r.index)
                if (resourceIndices.length > 0) {
                    if (!first) {
                        summary += ' + '
                    }
                    summary += type + ' ' + new MultiRange(resourceIndices.join(',')).getRanges()
                        .map(range => range[0] == range[1] ? range[0] : range[0] + '-' + range[1])
                        .join(',')
                    first = false
                }
            }
            summary += ']'
        }
        return summary
    } catch (ex) {}
}

async function migrate() {
    let db = JSON.parse(fs.readFileSync('/data/db.json'))

    for (let user of Object.keys(db.users).map(k => db.users[k])) {
        await models.User.create({
            id:       user.id,
            fullname: user.fullname,
            email:    user.email,
            password: user.password,
            admin:    user.admin
        })
    }

    for (let i = 0; i < db.jobIdCounter; i++) {
        console.log('Checking job index', i, '...')
        let pit = await models.Pit.create()
        let srcPath = '/data/pits/' + pit.id
        if (await fs.pathExists(srcPath)) {
            console.log('Importing job', pit.id, '...')
            let job
            try {
                job = JSON.parse(fs.readFileSync(srcPath + '/meta.json'))
            } catch (ex) {
                console.error('Problem reading meta data for job', pit.id, '.')
                continue
            }
            await models.Job.create({
                id:           pit.id,
                userId:       job.user,
                state:        job.state,
                description:  job.description || '',
                provisioning: job.provisioning || '',
                request:      job.request || '',
                allocation:   summarizeReservation(job.clusterReservation)
            })
            for (let state = 0; state <= 7; state++) {
                let stateChanged = job.stateChanges[state]
                if (stateChange) {
                    try {
                        stateChanged = new Date(stateChanged)
                    } catch (ex) {
                        continue
                    }
                    await models.State.create({
                        jobId: pit.id,
                        state: state,
                        since: stateChanged
                    })
                }
            }
            let log = ''
            if (await fs.pathExists(srcPath + '/preparation.log')) {
                log += fs.readFileSync(srcPath + '/preparation.log')
                log += '\n'
            }
            if (await fs.pathExists(srcPath + '/process_0_0.log')) {
                log += fs.readFileSync(srcPath + '/process_0_0.log')
            }
            fs.writeFileSync(srcPath + '/pit.log', log)
        } else {
            await pit.destroy()
        }
    }
}

migrate().then(() => {
    console.log('Migration done.')
}).catch((ex) => {
    console.error('Problem during migration:', ex)
})