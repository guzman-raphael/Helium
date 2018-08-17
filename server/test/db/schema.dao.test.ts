import { fail } from 'assert';
import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import * as joi from 'joi';
import { orderBy, random, uniq, zipObject } from 'lodash';
import * as moment from 'moment';
import { Filter, RawConstraint } from '../../src/common/api';
import { TableInsert } from '../../src/common/api/table-insert';
import {
    BLOB_STRING_REPRESENTATION,
    DATE_FORMAT,
    DATETIME_FORMAT
} from '../../src/common/constants';
import { ConnectionConf } from '../../src/db/connection-conf';
import { DatabaseHelper } from '../../src/db/database.helper';
import { SchemaDao, Sort } from '../../src/db/schema.dao';
import { ValidationError } from '../../src/routes/api/validation-error';

chai.use(chaiAsPromised);
const expect = chai.expect;

////////////////////////////////////////////////////////////////////////////////
// This suite tests interactions between SchemaDao and a MySQL database
// connection. These tests assume that init.sql was run successfully
////////////////////////////////////////////////////////////////////////////////

describe('SchemaDao', () => {
    // INFORMATION_SCHEMA.COLUMNS is pretty much guaranteed to have 100+
    // records since it contains all the definitions for all the columns in
    // all schemas (including INFORMATION_SCHEMA). COLUMN_NAME is the column
    // with the most diverse data, so we'll use that for sorting.
    const db = 'INFORMATION_SCHEMA'; // Use 'db' b/c name clashes with Joi vars
    const table = 'COLUMNS';
    const sortingRow = 'COLUMN_NAME'; // Row with very unique data
    const contentsRow = 'TABLE_NAME'; // Row with somewhat unique data
    const numColumns = 21; // number of columns in the above table

    const dbHelper = new DatabaseHelper(Infinity);
    let connectionPoolKey: string;
    let dao: SchemaDao;

    before(async () => {
        const conf: ConnectionConf = { user: 'user', password: 'password' };
        connectionPoolKey = await dbHelper.authenticate(conf);
    });

    beforeEach(() => {
        dao = new SchemaDao(dbHelper.queryHelper(connectionPoolKey));
    });

    describe('schemas', () => {
        it('should return an array of schema names', async () => {
            joi.assert(await dao.schemas(), joi.array().items(joi.string()).min(1));
        });
    });

    describe('tables', () => {
        it('should return an array of table names when a schema exists', async () => {
            const schemaName = 'helium_sample';
            const data = await dao.tables(schemaName);

            // The TableName constructor has its own tests, don't go into too
            // much detail here
            const transformedName = { raw: joi.string(), clean: joi.string() };
            const schema = joi.array().items(joi.object({
                schema: schemaName, // should be exactly the value of 'db'
                name: transformedName,
                tier: joi.string().regex(/lookup|manual|imported|computed|hidden/),
                // Allow null or a string
                masterName: joi.alternatives(transformedName, joi.only(null))
            }));

            joi.assert(data, schema);
        });

        it('should throw an Error when the schema doesn\'t exist', async () => {
            try {
                await dao.tables('unknown_schema');
                fail('Did not throw Error');
            } catch (ex) {
                expect(ex.code).to.equal('ER_DBACCESS_DENIED_ERROR');
            }
        });
    });

    describe('content', () => {
        // Each element in the array returned by content() should look like this
        const rowContents = joi.object().length(numColumns);

        it('should bring back 25 records by default', async () => {
            const data = await dao.content({ schema: db, table });
            const schema = joi.array().items(rowContents).length(25);
            joi.assert(data.rows, schema);
        });

        it('should sort by a given column when requested', async () => {
            // Request that we sort some row (defined above) in a particular
            // direction
            const sort: Sort = { by: 'pk', direction: 'asc'};
            const data = (await dao.content({ schema: 'helium_sample', table: 'big_table', sort })).rows;

            // Make sure we're still returning 25 elements by default
            joi.assert(data, joi.array().length(25));

            // Sort the returned data with lodash and ensure it matches what was
            // returned from the database
            const sorted = orderBy(data, sortingRow, sort.direction);
            expect(sorted).to.deep.equal(data);
        });

        it('should request different data when passed a different page', async () => {
            // Request the first 2 pages
            const [page1, page2] = await Promise.all(
                [1, 2].map((page) => dao.content({ schema: db, table, page }))
            );
            expect(page1).to.not.deep.equal(page2);
        });

        it('should throw an error given an invalid page', async () => {
            for (const pageNum of [-1, 0, 10000]) {
                await expect(dao.content({ schema: db, table, page: pageNum })).to.eventually
                    .be.rejectedWith(Error);
            }
        });

        it('should only allow limits >= 1', async () => {
            for (const limit of [-1, 0]) {
                await expect(dao.content({ schema: db, table, limit })).to.eventually
                    .be.rejectedWith(Error);
            }

            // Choose limits that are explicitly under the usual amount of
            // records in the chosen table
            for (const limit of [1, 10, 100]) {
                const schema = joi.array().items(rowContents).length(limit);
                joi.assert((await dao.content({ schema: db, table, limit })).rows, schema);
            }
        });

        it('should format dates and datetimes', async () => {
            const data = await dao.content({ schema: 'helium_sample', table: 'datatypeshowcase' });

            for (const row of data.rows) {
                if (row.date !== null)
                    expect(moment(row.date, DATE_FORMAT, true).isValid()).to.be.true;

                if (row.time !== null)
                    expect(moment(row.time, DATETIME_FORMAT, true).isValid()).to.be.true;
            }
        });

        it('should format blobs', async () => {
            const data = await dao.content({ schema: 'helium_sample', table: 'datatypeshowcase' });

            for (const row of data.rows) {
                if (row.blob !== null) {
                    expect(row.blob).to.equal(BLOB_STRING_REPRESENTATION);
                }
            }
        });

        describe('filters', () => {
            const fetch = (tableName: string, filters: Filter[]) =>
                dao.content({ schema: 'helium_sample', table: tableName, filters });

            it('should return the number of rows that apply to the given filters', async () => {
                const data = await fetch('big_table', [{ param: 'pk', op: 'lt', value: '101' }]);

                // There are 100 rows total using the above filters, but we're
                // returning 25 at a time
                expect(data.count).to.equal(100);
                expect(data.rows).to.have.lengthOf(25);
            });

            describe('eq', () => {
                it('should handle numbers', async () => {
                    // Numeric equals
                    await expect(await fetch(
                        'product',
                        [{ param: 'product_id', op: 'eq', value: '23' }]
                    )).to.deep.equal({
                        rows: [{
                            product_id: 23,
                            product_name: 'Crackers',
                            price: 3.49
                        }],
                        count: 1
                    });
                });

                it('should handle strings (ignoring case)', async () => {
                    // String equals (ignore case)
                    await expect(fetch(
                        'product',
                        [{ param: 'product_name', op: 'eq', value: 'soda' }])
                    ).to.eventually.deep.equal({
                        rows: [{
                            product_id: 22,
                            product_name: 'Soda',
                            price: 1.99
                        }],
                        count: 1
                    });
                });

                it('should handle dates and datetimes', async () => {
                    // Dates
                    await expect(fetch(
                        'shipment',
                        [{ param: 'shipped', op: 'eq', value: '2017-07-01' }])
                    ).to.eventually.deep.equal({
                        rows: [{
                            shipment_id: 30,
                            order_id: 40,
                            organization_id: 10,
                            customer_id: 0,
                            product_id: 20,
                            shipped: '2017-07-01'
                        }],
                        count: 1
                    });

                    // Datetimes/timestamps
                    const data = await fetch(
                        'datatypeshowcase',
                        [{ param: 'time', op: 'eq', value: '2000-01-01 12:00:00'}]
                    );
                    expect(data.rows).to.have.lengthOf(1);
                    expect(data.rows[0].time).to.equal('2000-01-01 12:00:00');
                });
            });

            describe('lt', () => {
                it('should handle numbers', async () => {
                    // Numeric less than
                    const numericLt = (await fetch(
                        'product',
                        [{ param: 'product_id', op: 'lt', value: '24' }]
                    )).rows;

                    for (const row of numericLt) {
                        expect(row.product_id).to.be.below(24);
                    }
                });

                it('should handle dates and datetimes', async () => {
                    // Date less than
                    expect((await fetch(
                        'datatypeshowcase',
                        [{ param: 'date', op: 'lt', value: '2017-07-02' }]
                    )).rows).to.have.lengthOf(1);

                    // Datetime less than
                    expect((await fetch(
                        'datatypeshowcase',
                        [{ param: 'time', op: 'lt', value: '2001-01-01 12:00:00' }]
                    )).rows).to.have.lengthOf(1);
                });
            });

            describe('gt', () => {
                it('should handle numbers', async () => {
                    // Numeric less than
                    const numericGt = (await fetch(
                        'product',
                        [{ param: 'product_id', op: 'gt', value: '21' }]
                    )).rows;

                    for (const row of numericGt) {
                        expect(row.product_id).to.be.above(21);
                    }
                });

                it('should handle dates and datetimes', async () => {
                    // Date less than
                    expect((await fetch(
                        'datatypeshowcase',
                        [{ param: 'date', op: 'gt', value: '2017-07-02' }]
                    )).rows).to.have.lengthOf(2);

                    // Datetime less than. For whatever reason MySQL says that
                    // NULL dates are greater than any given time
                    expect((await fetch(
                        'datatypeshowcase',
                        [{ param: 'time', op: 'gt', value: '2015-01-01 12:00:00' }]
                    )).rows).to.have.lengthOf(3);
                });
            });

            describe('is', () => {
                it('should handle nulls', async () => {
                    expect((await fetch(
                        'datatypeshowcase',
                        [{ param: 'blob', op: 'is', value: 'null' }]
                    )).rows).to.have.lengthOf(2);
                });

                it('should reject when given an unrecognized value', async () => {
                    await expect(fetch(
                        'datatypeshowcase',
                        [{ param: 'blob', op: 'is', value: '(unknown)'}]
                    )).to.eventually.be.rejectedWith(Error);
                });
            });

            describe('isnot', () => {
                it('should handle nulls', async () => {
                    expect((await fetch(
                        'datatypeshowcase',
                        [{ param: 'blob', op: 'isnot', value: 'null' }]
                    )).rows).to.have.lengthOf(2);
                });

                it('should reject when given an unrecognized value', async () => {
                    await expect(fetch(
                        'datatypeshowcase',
                        [{ param: 'blob', op: 'isnot', value: '(unknown)'}]
                    )).to.eventually.be.rejectedWith(Error);
                });
            });

            it('should allow multiple filters', async () => {
                const filters: Filter[] = [
                    { op: 'lt', param: 'product_id', value: '24' },
                    { op: 'gt', param: 'product_id', value: '21' }
                ];

                const data = await fetch('product', filters);
                for (const row of data.rows) {
                    expect(row.product_id).to.be.above(21).and.below(24);
                }
            });

            it('should fail on unknown filter operations', async () => {
                const filter: any = { op: 'eq2', param: 'product_id', value: '20' };
                await expect(fetch('product', [filter]))
                    .to.eventually.be.rejectedWith(Error);
            });

            it('should be safe from simple SQL injection', async () => {
                const filter: Filter = { op: 'eq', param: 'product_id\'', value: '\'20'};
                await expect(fetch('product', [filter])).to.be.rejectedWith(Error);
            });
        });
    });

    describe('meta', () => {
        it('should return a TableMeta object with fully resolved constraints', async () => {
            const schemaName = 'helium_sample';
            const tableName = 'shipment';
            const cols = 6;
            const numConstraints = 2;
            const data = await dao.meta(schemaName, tableName);

            // Very basic schema to make sure we have the basics down
            const schema = joi.object({
                schema: joi.only(schemaName),
                name: joi.only(tableName),
                headers: joi.array().length(cols),
                totalRows: joi.number().integer().min(0),
                constraints: joi.array().length(numConstraints),
                comment: joi.string().allow(''),
                parts: joi.array().length(0)
            }).requiredKeys('schema', 'name', 'headers', 'totalRows', 'constraints', 'comment', 'parts');

            joi.assert(data, schema);
        });

        it('should include TableNames for part tables when applicable', async () => {
            // helium.master has 2 part tables
            expect((await dao.meta('helium_sample', 'master')).parts).to.have.lengthOf(2);
            // helium.master__part is a part table
            expect((await dao.meta('helium_sample', 'master__part')).parts).to.have.lengthOf(0);
        });

        it('should throw an Error when the schema doesn\'t exist', async () => {
            await expect(dao.meta('unknown_schema', 'irrelevant'))
                .to.eventually.be.rejected;
        });

        it('should throw an Error when the table doesn\'t exist', async () => {
            await expect(dao.meta('helium_sample', 'unknown_table')).to.eventually.be.rejected;
        });
    });

    describe('defaults', () => {
        it('should return only the requested table when it has no part tables', async () => {
            const defaults = await dao.defaults('helium_sample', 'defaults_test');

            // The `pk` field is auto_increment, try to detect what the next
            // value is
            const pkSearchResults = await dao.content({
                schema: 'helium_sample',
                table: 'defaults_test',
                limit: 1,
                sort: { by: 'pk', direction: 'desc' }
            });

            const pkValue = 1 + (pkSearchResults.count > 0 ? pkSearchResults.rows[0].pk : 0);

            expect(defaults).to.deep.equal({
                pk: pkValue,
                int: 5,
                float: 10.0,
                date: '2017-01-01',
                datetime: '2017-01-01 12:00:00',
                // The default is CURRENT_TIMESTAMP, but this should be
                // resolved to a datetime string.
                datetime_now: moment().format('YYYY-MM-DD HH:mm:ss'),
                boolean: true,
                enum: 'a',
                no_default: null
            });
        });
    });

    describe('constraints', () => {
        it('should identify basic features about a constraint', async () => {
            const constraints = await dao.constraints('helium_sample', 'master');
            expect(constraints).to.have.lengthOf(1);
            const constraint = constraints[0];

            const expected: RawConstraint = {
                index: 0,
                name: 'PRIMARY',
                localColumn: 'pk',
                type: 'primary',
                ref: null
            };

            expect(constraint).to.deep.equal(expected);
        });

        it('should identify foreign constraints', async () => {
            const constraints = await dao.constraints('helium_sample', 'master__part');
            const foreignKeys = constraints.filter((c) => c.type === 'foreign');

            expect(foreignKeys).to.have.lengthOf(1);
            const expected: RawConstraint = {
                index: 0,
                name: 'master__part_ibfk_1',
                localColumn: 'master',
                type: 'foreign',
                ref: {
                    schema: 'helium_sample',
                    table: 'master',
                    column: 'pk'
                }
            };

            expect(foreignKeys[0]).to.deep.equal(expected);
        });

        it('should identify unique constraints', async () => {
            const constraints = await dao.constraints('helium_sample', 'datatypeshowcase');
            const uniqueConstraints = constraints.filter((c) => c.type === 'unique');

            expect(uniqueConstraints).to.have.lengthOf(1);

            const expected: RawConstraint = {
                index: 0,
                name: 'integer',
                localColumn: 'integer',
                type: 'unique',
                ref: null
            };

            expect(uniqueConstraints[0]).to.deep.equal(expected);
        });
    });

    describe('resolveConstraints', () => {
        it('should resolve reference chains within the same schema', async () => {
            const constraints = await dao.constraints('helium_sample', 'shipment');
            const resolved = await dao.resolveConstraints(constraints);

            // In the actual schema:
            // 1. shipment.product_id ==>   order.product_id
            // 2.    order.product_id ==> product.product_id
            //
            // We expect to see:
            // 1. shipment.product_id ==> product.product_id

            expect(resolved).to.deep.include({
                name: 'shipment_ibfk_1',
                index: 3,
                type: 'foreign',
                localColumn: 'product_id',
                ref: {
                    schema: 'helium_sample',
                    table: 'product',
                    column: 'product_id'
                }
            });
        });

        it('should resolve reference chains that involve more than one schema', async () => {
            const constraints = await dao.constraints('helium_cross_schema_ref_test', 'cross_schema_ref_test');
            const resolved = await dao.resolveConstraints(constraints);

            // In the actual schema:
            // 1. helium_cross_schema_ref_test.cross_schema_ref_test.fk ==> helium.order.customer_id
            // 2.                       helium_sample.order.customer_id ==> helium.customer.customer_id
            //
            // We expect to see:
            // 1. helium_cross_schema_ref_test.cross_schema_ref_test.fk ==> helium.customer.customer_id

            expect(resolved).to.deep.include({
                name: 'cross_schema_ref_test_ibfk_1',
                index: 0,
                type: 'foreign',
                localColumn: 'fk',
                ref: {
                    schema: 'helium_sample',
                    table: 'customer',
                    column: 'customer_id'
                }
            });
        });
    });

    describe('resolveCompoundConstraints', () => {
        it('should create one compound constraint for each unique constraint name', async () => {
            const compoundConstraints = SchemaDao.resolveCompoundConstraints(
                await dao.constraints('helium_compound_fk_test', 'fk_table'));
            
            // 1 PK and 2 FK's
            expect(compoundConstraints).to.have.lengthOf(3);
            expect(compoundConstraints.map((c) => c.name).sort()).to.deep.equal([
                'PRIMARY',
                'fk_table_ibfk_1',
                'fk_table_ibfk_2'
            ]);

            for (const compoundConstraint of compoundConstraints) {
                // The primary key is not compound, but there are two compound
                // foreign keys that contain 3 columns.
                const length = compoundConstraint.type === 'primary' ? 1 : 3;
                expect(compoundConstraint.constraints).to.have.lengthOf(length);

                // Make sure we're given Constraints, not RawConstraints
                for (const constraint of compoundConstraint.constraints) {
                    expect((constraint as any).name).to.be.undefined;
                    expect((constraint as any).index).to.be.undefined;
                }
            }
        });

        it('should not allow two constraints with the same index and name', () => {
            const constraint: RawConstraint = {
                name: 'test',
                index: 0,
                localColumn: 'foo',
                ref: null,
                type: 'primary'
            };

            expect(() => SchemaDao.resolveCompoundConstraints([constraint, constraint]))
                .to.throw(Error);
        });

        it('should not allow a constraint index greater than the max value', () => {
            const constraints: RawConstraint[] = [{
                name: 'test',
                index: 1, // <-- here's the problem
                localColumn: 'foo',
                ref: null,
                type: 'primary'
            }];

            expect(() => SchemaDao.resolveCompoundConstraints(constraints))
                .to.throw(Error);
        });
    });

    describe('columnContent', () => {
        it('should return all unique values for a specific column', async () => {
            const data = await dao.columnContent(db, table, contentsRow);

            // Make sure we're only being returned unique data
            expect(uniq(data)).to.deep.equal(data);
        });

        it('should throw an Error if the schema doesn\'t exist', async () => {
            try {
                await dao.columnContent('unknown_schema', table, contentsRow);
                fail('Should have thrown an Error');
            } catch (ex) {
                expect(ex.code).to.equal('ER_TABLEACCESS_DENIED_ERROR');
            }
        });

        it('should throw an Error if the table doesn\'t exist', async () => {
            const error = await expect(dao.columnContent(db, 'unknown_table', contentsRow))
                .to.eventually.be.rejected;
            expect(error.code).to.equal('ER_UNKNOWN_TABLE');
        });

        it('should throw an Error if the column doesn\'t exist', async () => {
            const error = await expect(dao.columnContent(db, table, 'unknown_row'))
                .to.eventually.be.rejected;
            expect(error.code).to.equal('ER_BAD_FIELD_ERROR');
        });
    });

    describe('insertRow', () => {
        // The TableInputValidator class tests handle validation testing

        /** Generate a very large random unsigned integer */
        const randInt = () => random(10000000);

        /** Resolves to the total number of rows in the table */
        const count = (schemaName: string, tableName: string) =>
            dao.meta(schemaName, tableName).then((meta) => meta.totalRows);

        /**
         * Resolves to an object that maps table names to the number of rows
         * in that table
         */
        const getCounts = async (schemaName, data: TableInsert) => zipObject(
            Object.keys(data),
            await Promise.all(Object.keys(data).map((tableName) => count(schemaName, tableName)))
        );

        /**
         * Tries to insert some data and verifies that the same number of
         * entries to each table were inserted into that table.
         */
        const insertAndAssert = async (schema: string, data: TableInsert) => {
            // Keep track of the amount of rows before
            const before = await getCounts(schema, data);

            // Insert the data
            await dao.insertRow(schema, data);

            // Get the amount of rows after the insert
            const after = await getCounts(schema, data);

            // Expect that the amount of rows in each table has increased by
            // the number of entries specified
            for (const tableName of Object.keys(data)) {
                expect(after[tableName]).to.equal(before[tableName] + data[tableName].length);
            }
        };

        it('should insert data into the given table', async () => {
            await insertAndAssert('helium_sample', {
                customer: [{
                    customer_id: random(100000),
                    name: 'test name'
                }]
            });
        });

        it('should insert all data if the main table is a master table', async () => {
            // Create some random data here
            const masterPk = randInt();

            await insertAndAssert('helium_sample', {
                master: [{
                    pk: masterPk
                }],
                master__part: [
                    { part_pk: randInt(), master: masterPk, default_test: 4 },
                    { part_pk: randInt(), master: masterPk, default_test: 5 }
                ]
            });
        });

        it('should allow inserting zero rows into a part table', async () => {
            await insertAndAssert('helium_sample', {
                master: [{ pk: random(10000000) }],
                master__part: []
            });
        });
    });

    describe('headers', () => {
        it('should return a TableHeader object for each column in the schema', async () => {
            // Very basic for now
            const data = await dao.headers(db, table);
            joi.assert(data, joi.array().items(joi.object()).length(numColumns));
        });

        it('should prioritize auto-increment defaults', async () => {
            const meta = await dao.meta('helium_sample', 'defaults_test');
            const headers = meta.headers;
            const autoIncCol = 'pk';
            const expectedAutoIncValue = meta.totalRows + 1;
            const pk = headers.find((h) => h.name === autoIncCol);
            expect(pk!!.defaultValue).to.equal(expectedAutoIncValue);

            const other = headers.find((h) => h.name !== autoIncCol);
            expect(other!!.defaultValue).to.not.equal(expectedAutoIncValue);
        });
    });

    describe('pluck', () => {
        it('should throw an Error if the given keys don\'t identify exactly one row', async () => {
            await expect(dao.pluck('helium_sample', 'master', { pk : '999 ' }))
                .to.be.rejectedWith(ValidationError);
        });

        it('should throw an Error if the selector keys and values are anything but strings', async () => {
            await expect(dao.pluck('heilum', 'master', { pk: true } as any))
                .to.be.rejectedWith(Error);
        });

        it('should return only that row if it does not have any part table entries', async () => {
            expect(await dao.pluck('helium_sample', 'master', { pk: '1000' }))
                .to.deep.equal({ master: [{ pk: 1000 }]});
        });

        it('should return all data in all part tables associated with the specified row', async () => {
            expect(await dao.pluck('helium_sample', 'master', { pk: '1001' }))
                .to.deep.equal({
                    master: [{ pk: 1001 }],
                    master__part: [{ part_pk: 100, master: 1001, default_test: 12345 }]
                });

            expect(await dao.pluck('helium_sample', 'master', { pk: '1002' }))
                .to.deep.equal({
                    master: [
                        { pk: 1002 }
                    ],
                    master__part: [
                        { part_pk: 101, master: 1002, default_test: 12345 },
                        { part_pk: 102, master: 1002, default_test: 12345 }
                    ],
                    master__part2: [
                        { part2_pk: 100, master: 1002 }
                    ]
            });
        });

        it('should format dates, datetimes, and blobs', async () => {
            const data = await dao.pluck('helium_sample', 'datatypeshowcase', { pk: '100' });

            const row = data.datatypeshowcase[0];
            expect(moment(row.date, DATE_FORMAT, true).isValid()).to.be.true;
            expect(moment(row.time, DATETIME_FORMAT, true).isValid()).to.be.true;
            expect(row.blob).to.equal(BLOB_STRING_REPRESENTATION);
        });

        it('should format blobs', async () => {
            const data = await dao.content({ schema: 'helium_sample', table: 'datatypeshowcase' });

            for (const row of data.rows) {
                if (row.blob !== null) {
                    expect(row.blob).to.equal(BLOB_STRING_REPRESENTATION);
                }
            }
        });
    });

    describe('erd', () => {
        it('TODO', async () => {
            // TODO
            const { nodes, edges } = await dao.erd();
            console.log(nodes.map((n) => ({ id: n.id, table: n.table.schema + '.' + n.table.name.raw })));
            console.log(edges);
        });
    });
});
