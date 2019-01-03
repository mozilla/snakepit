
CREATE TABLE users (
    username      VARCHAR (10)           NOT NULL PRIMARY KEY,
    password      VARCHAR (1024)         NOT NULL,
    email         VARCHAR (320)          NOT NULL,
    admin         BOOLEAN                NOT NULL
);

CREATE TABLE user_groups (
    username      VARCHAR (10)           NOT NULL
        CONSTRAINT user_group__ref__users
            REFERENCES users
                ON UPDATE CASCADE
                ON DELETE CASCADE
                DEFERRABLE,
    groupname     VARCHAR (10)           NOT NULL,
    UNIQUE (username, groupname)
);

CREATE TABLE nodes (
    nodename      VARCHAR (10)           NOT NULL PRIMARY KEY,
    endpoint      VARCHAR (1024)         NOT NULL,
    nodestate     INTEGER                NOT NULL
);

CREATE TABLE resources (
    resnumber     SERIAL                 NOT NULL PRIMARY KEY,
    nodename      VARCHAR (10)           NOT NULL
        CONSTRAINT resource__ref__nodes
            REFERENCES nodes
                ON UPDATE CASCADE
                ON DELETE CASCADE
                DEFERRABLE,
    restype       VARCHAR (10)           NOT NULL,
    resindex      INTEGER                NOT NULL,
    resname       VARCHAR (255)          NOT NULL,
    UNIQUE (nodename, restype, resindex)
);

CREATE TABLE resource_groups (
    resnumber     INTEGER                NOT NULL
        CONSTRAINT resource_group__ref__resources
            REFERENCES resources
                ON UPDATE CASCADE
                ON DELETE CASCADE
                DEFERRABLE,
    groupname     VARCHAR (10)           NOT NULL,
    UNIQUE (resnumber, groupname)
);

CREATE TABLE aliases (
    alias         VARCHAR (10)           NOT NULL PRIMARY KEY,
    name          VARCHAR (255)          NOT NULL
);

CREATE SEQUENCE pits START 1;

CREATE TABLE jobs (
    jobnumber     SERIAL                 NOT NULL PRIMARY KEY,
    jobdesc       VARCHAR (20)           NOT NULL,
    username      VARCHAR (10)           NOT NULL,
    jobstate      INTEGER                NOT NULL,
    resrequest    VARCHAR (1024)         NOT NULL,
    provisioning  VARCHAR (1024)         NOT NULL
);

CREATE TABLE job_groups (
    jobnumber     INTEGER                NOT NULL
        CONSTRAINT job_group__ref__jobs
            REFERENCES jobs
                ON UPDATE CASCADE
                ON DELETE CASCADE
                DEFERRABLE,
    groupname     VARCHAR (10)           NOT NULL,
    UNIQUE (jobnumber, groupname)
);

CREATE TABLE job_states (
    jobnumber     INTEGER                NOT NULL
        CONSTRAINT job_state__ref__jobs
            REFERENCES jobs
                ON UPDATE CASCADE
                ON DELETE CASCADE
                DEFERRABLE,
    jobstate      INTEGER                NOT NULL,
    since         DATE                   NOT NULL,
    reason        VARCHAR (1024),
    UNIQUE (jobnumber, jobstate)
);

CREATE TABLE process_groups (
    groupnumber   SERIAL                 NOT NULL PRIMARY KEY,
    jobnumber     INTEGER                NOT NULL
        CONSTRAINT process_group__ref__jobs
            REFERENCES jobs
                ON UPDATE CASCADE
                ON DELETE CASCADE
                DEFERRABLE,
    groupindex    INTEGER                NOT NULL,
    UNIQUE (jobnumber, groupindex)
);

CREATE TABLE processes (
    procnumber    SERIAL                 NOT NULL PRIMARY KEY,
    groupnumber   INTEGER                NOT NULL
        CONSTRAINT process__ref__process_groups
            REFERENCES process_groups
                ON UPDATE CASCADE
                ON DELETE CASCADE
                DEFERRABLE,
    procindex     INTEGER                NOT NULL,
    exitstatus    INTEGER,
    result        VARCHAR (20),
    UNIQUE (groupnumber, procindex)
);

CREATE TABLE allocations (
    allocnumber   SERIAL                 NOT NULL PRIMARY KEY,
    procnumber    INTEGER                NOT NULL
        CONSTRAINT allocation__ref__processes
            REFERENCES processes
                ON UPDATE CASCADE
                ON DELETE CASCADE
                DEFERRABLE,
    resnumber     INTEGER                NOT NULL,
    UNIQUE (procnumber, resnumber)
);

CREATE TABLE utilizations (
    allocnumber   INTEGER                NOT NULL
        CONSTRAINT utilization__ref__allocations
            REFERENCES allocations
                ON UPDATE CASCADE
                ON DELETE CASCADE
                DEFERRABLE,
    utiltype      VARCHAR (10)           NOT NULL,
    aggregated    INTEGER                NOT NULL,
    samples       INTEGER                NOT NULL,
    current       INTEGER                NOT NULL,
    UNIQUE (allocnumber, utiltype)
);
