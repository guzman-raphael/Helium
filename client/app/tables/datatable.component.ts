import { Component, Input, OnDestroy, OnInit, TemplateRef, ViewChild } from '@angular/core';
import { Response } from '@angular/http';
import { BehaviorSubject, Observable, Subscription } from 'rxjs/Rx';

import * as _ from 'lodash';
import * as moment from 'moment';

import {
    Constraint, ConstraintType, SqlRow, TableHeader, TableMeta
} from '../common/responses';
import { BOOLEAN_TYPE } from '../core/constants';
import { TableService } from '../core/table.service';

interface ConstraintGrouping {
    [headerName: string]: Constraint[];
}

interface DataTableHeader {
    name: string;
    prop: string;
}

@Component({
    selector: 'datatable',
    templateUrl: 'datatable.component.html',
    styleUrls: ['datatable.component.scss']
})
export class DatatableComponent implements OnInit, OnDestroy {

    @Input()
    public set name(value) { this._name$.next(value); }
    public get name() { return this._name$.getValue(); }

    public set pageNumber(value) { this._pageNumber$.next(value); }
    public get pageNumber() { return this._pageNumber$.getValue(); }

    private set sort(value) { this._sort$.next(value); }

    public set meta(value) { this._meta$.next(value); }
    public get meta() { return this._meta$.getValue(); }

    private _name$ = new BehaviorSubject(null);
    private _pageNumber$ = new BehaviorSubject(1);
    private _sort$ = new BehaviorSubject(null);
    private _meta$ = new BehaviorSubject<TableMeta>(null);

    private nameSub: Subscription;
    private pageInfoSub: Subscription;

    private constraints: ConstraintGrouping = {};
    public tableHeaders: DataTableHeader[];

    @ViewChild('headerTemplate') private headerTemplate: TemplateRef<any>;
    @ViewChild('cellTemplate') private cellTemplate: TemplateRef<any>;

    /** True if this component has tried to access the table and found data */
    public exists: boolean = true;
    public loading = false;

    /** How many rows to fetch per page */
    public readonly limit: number = 25;

    public data: SqlRow[] = [];

    constructor(
        private backend: TableService
    ) {}

    public ngOnInit(): void {
        this.nameSub = this._name$
            .distinctUntilChanged()
            .do(() => { this.loading = true; })
            .switchMap((newName) => {
                // Create a disposable Observable so we don't end up completing
                // the main one. This way, if an error occurs, we can still
                // react to changes in the table name
                return this.backend.meta(newName)
                    .catch((err) => {
                        if (err instanceof Response && err.status === 404) {
                            // Handle 404s, show the user that the table couldn't be
                            // found
                            return Observable.of(null);
                        } else {
                            // Unknown error
                            throw err;
                        }
                    });
            })
            .subscribe((meta: TableMeta | null) => {
                this.loading = false;
                this.exists = meta !== null;
                if (meta !== null) {
                    this.meta = meta;
                    this.tableHeaders = this.createTableHeaders(this.meta.headers);
                    this.constraints = _.groupBy(this.meta.constraints, 'localColumn');

                    this.reset();
                }
            });

        this.pageInfoSub = Observable
            // Take the latest pageNumber and sort and transform them into an
            // object
            .combineLatest(
                this._name$,
                this._pageNumber$,
                this._sort$,
                this._meta$,
                (name: string, pageNumber: number, sort: string, meta: TableMeta) => ({
                    name,
                    pageNumber,
                    sort,
                    meta
                })
            )
            // Make sure we're only requesting data stemming from filters
            // different from the previous one
            .filter((args) => !_.isNil(args.meta) && !_.isNil(args.name))
            .distinctUntilChanged()
            .do(() => { this.loading = true; })
            .switchMap((args: any) => {
                return this.backend.content(args.name, args.pageNumber, this.limit, args.sort)
                    .catch((err) => {
                        // TODO handle this properly
                        throw err;
                    })
                    .map((rows: SqlRow[]) => {
                        try {
                            return this.formatRows(args.meta.headers, rows);
                        } catch (e) {
                            // TODO we're putting a bandaid on a stab wound here,
                            // there's a race condition here and I don't know
                            // how to fix it
                            console.error('Unable to format rows');
                            return rows;
                        }
                    });
            })
            .subscribe((data: SqlRow[]) => {
                this.loading = false;
                this.data = data;
            });
    }

    public ngOnDestroy(): void {
        // Clean up our subscriptions
        this.nameSub.unsubscribe();
        this.pageInfoSub.unsubscribe();
    }

    public onPaginate(event: any) {
        // page 1 === offset 0, page 2 === offset 1, etc.
        this.pageNumber = event.offset + 1;
    }

    public onSort(event: any) {
        const sortDirPrefix = event.sorts[0].dir === 'desc' ? '-' : '';
        // '-prop' for descending, 'prop' for ascending
        this.sort = sortDirPrefix + event.sorts[0].prop;
    }

    private createTableHeaders(headers: TableHeader[]): DataTableHeader[] {
        return _.sortBy(_.map(headers, (h) => ({ 
            name: h.name,
            prop: h.name,
            cellTemplate: this.cellTemplate,
            headerTemplate: this.headerTemplate
        })), 'ordinalPosition');
    }

    private formatRows(headers: TableHeader[], rows: SqlRow[]): SqlRow[] {
        const copied = _.clone(rows);

        // Iterate through each row
        for (const row of copied) {
            // Iterate through each cell in that row
            for (const headerName of Object.keys(row)) {
                const header = _.find(headers, (h) => h.name === headerName);
                // Use moment to format dates and times in the default format
                if (header.type === 'date')
                    row[headerName] = DatatableComponent.formatMoment(row[headerName], 'l');
                if (header.type === 'timestamp' || header.type === 'datetime')
                    row[headerName] = DatatableComponent.formatMoment(row[headerName], 'LLL');
                if (header.rawType === BOOLEAN_TYPE)
                    // Resolve either the 1 or 0 to its boolean value
                    row[headerName] = !!row[headerName];
            }
        }

        return copied;
    }

    private reset(): void {
        this.pageNumber = 1;
        this.sort = null;
    }

    /**
     * Tries to format a given date into the format given. If the source is not
     * a valid date, returns null.
     * 
     * @param source A string parsable by Moment
     * @param format Any format accepted by Moment
     */
    private static formatMoment(source: string, format: string): string | null {
        const m = moment(source);
        return m.isValid() ? m.format(format) : null;
    }
}
