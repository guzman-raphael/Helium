import * as bodyParser from 'body-parser';
import cookieSession = require('cookie-session');
import { Application } from 'express';
import * as express from 'express';
import * as helmet from 'helmet';
import * as logger from 'morgan';
import * as passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import * as path from 'path';

import { ConnectionConf } from './db/connection-conf.interface';
import { DatabaseHelper } from './db/database.helper';
import { DaoFactory } from './routes/api/dao.factory';
import { api } from './routes/api/index';
import { SchemaDao } from './routes/api/schemas/schema.dao';
import { front } from './routes/front';

export class Helium {
    // TODO: Make this configurable
    /** Maximum length of a session before it expires */
    private static readonly SESSION_LENGTH = 30 * 60 * 1000;

    private app: Application | null = null;
    private db: DatabaseHelper | null = null;

    public get express(): Application {
        if (this.app === null)
            throw new Error('Not start()\'d yet');
        return this.app;
    }

    public get database(): DatabaseHelper {
        if (this.db === null)
            throw new Error('Not start()\'d yet');
        return this.db;
    }

    public async start(
        // The poor man's dependency injection. Mainly for testing.
        daoFactory: DaoFactory = (dbHelper: DatabaseHelper, apiKey: string) =>
            new SchemaDao(dbHelper.queryHelper(apiKey))
    ) {
        const app = express();
        app.use(logger('dev'));
        app.use(bodyParser.urlencoded({ extended: false }));
        app.use(bodyParser.json());
        app.use(cookieSession({
            name: 'sessionId',
            // TODO change for production builds
            secret: 'super duper secret key',
            maxAge: Helium.SESSION_LENGTH
        }));
        app.use(helmet());
        app.use(passport.initialize());
        app.use(passport.session());

        const db = new DatabaseHelper(Helium.SESSION_LENGTH);
        app.use('/api/v1', api(db, passport, daoFactory));
        this.db = db;

        passport.use(new LocalStrategy(
            // Set this to true so that the first parameter to the callback fn
            // will be the request object so we can grab more data from the
            // request body
            { passReqToCallback: true },
            async (req, username, password, done) => {
                const conf: ConnectionConf = {
                    user: username,
                    password,
                    host: req.body.host
                };

                db.authenticate(conf)
                    .then((key: string) => {
                        // Successfully authenticated with the database
                        return done(null, key);
                    })
                    .catch(() => {
                        // Unable to authenticate. Use false to indicate
                        // authentication failure
                        return done(null, false);
                    });
            }
        ));

        // We're required to implement this
        passport.serializeUser((key, done) => {
            done(null, key);
        });
        passport.deserializeUser((key, done) => {
            done(null, key);
        });

        // Mount static assets before the front() module so we can still use our
        // assets without the front()'s wildcard route catching it first
        app.use(express.static(path.join(__dirname, 'public')));
        app.use('/', front());

        this.app = app;
    }
}
