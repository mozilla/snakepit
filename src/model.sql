PRAGMA temp_store=MEMORY;

CREATE TABLE IF NOT EXISTS aliases (alias TEXT UNIQUE, name TEXT);

CREATE VIEW IF NOT EXISTS autoshare (
    user TEXT, 
    group TEXT,
    UNIQUE(user, group) ON CONFLICT IGNORE,
    CONSTRAINT fk_user
        FOREIGN KEY (user)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_groups (
    user TEXT, 
    group TEXT,
    UNIQUE(user, group) ON CONFLICT IGNORE,
    CONSTRAINT fk_user
        FOREIGN KEY (user)
        REFERENCES users(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS job_groups (
    job INT, 
    group TEXT,
    UNIQUE(job, group) ON CONFLICT IGNORE,
    CONSTRAINT fk_job
        FOREIGN KEY (job)
        REFERENCES jobs(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS resource_groups (
    resource INT, 
    group TEXT,
    UNIQUE(resource, group) ON CONFLICT IGNORE,
    CONSTRAINT fk_resource
        FOREIGN KEY (resource)
        REFERENCES resources(id)
        ON DELETE CASCADE
);

CREATE VIEW IF NOT EXISTS groups (group TEXT) AS
SELECT DISTINCT group FROM (
    SELECT group FROM user_groups
    UNION
    SELECT group FROM job_groups
    UNION
    SELECT group FROM resource_groups
    UNION
    SELECT group FROM autoshare
);

CREATE TABLE IF NOT EXISTS nodes (
    id TEXT,
    address TEXT,
    port INT,
    user TEXT,
    state INT,
    UNIQUE(id) ON CONFLICT REPLACE
);

CREATE TABLE IF NOT EXISTS resources (
    node TEXT,
    type TEXT,
    index INT,
    pid INT,
    job INT,
    UNIQUE(node, type, index) ON CONFLICT REPLACE,
    CONSTRAINT fk_node
        FOREIGN KEY (node)
        REFERENCES nodes(node)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
    id TEXT,
    fullname TEXT,
    email: TEXT,
    admin BOOLEAN,
    UNIQUE(id) ON CONFLICT REPLACE
);


SELECT * FROM nodes n WHERE (
    SELECT COUNT(*) 
    FROM resources r 
    WHERE 
        r.node == n.node AND 
        r.name == q.name AND 
        ($simulation OR (r.pid == 0 AND r.job == 0)) AND 
        (
            EXISTS (SELECT group FROM resource_groups WHERE r.oid == oid INTERSECT SELECT group FROM user_groups WHERE user == $user) OR 
            NOT EXISTS (SELECT group FROM resource_groups WHERE r.oid == oid)
        ) AND
        NOT r.oid IN (SELECT id FROM reserved)
) LIMIT 1;

