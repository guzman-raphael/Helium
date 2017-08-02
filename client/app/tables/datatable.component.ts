import { Component, Input, OnDestroy, OnInit, TemplateRef, ViewChild } from '@angular/core';
import { Response } from '@angular/http';
import { BehaviorSubject, Observable, Subscription } from 'rxjs/Rx';

import * as _ from 'lodash';
import * as moment from 'moment';

import {
    Constraint, SqlRow, TableHeader, TableMeta
} from '../common/responses';
import { TableService } from '../core/table.service';
import { Subject } from 'rxjs/Subject';

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
        const pageInfo = Observable.combineLatest(
            this._meta$,
            this._name$,
            this._pageNumber$,
            this._sort$
        );

        // When pauser emits true, pausable will map to an Observable that never
        // emits any values. When pauser emits false, it will map to pageInfo
        const pauser = new Subject<boolean>();
        const pausable = pauser.switchMap((paused) => paused ? Observable.never() : pageInfo);

        this.nameSub = this._name$
            .distinctUntilChanged()
            // Pause pageInfo
            .do(() => { pauser.next(true); })
            .switchMap((name) => {
                return this.backend.meta(name)
                    .catch((err) => {
                        this.exists = false;
                        // TODO Handle this properly
                        throw err;
                    });
            })
            .subscribe((meta: TableMeta) => {
                this.exists = true;
                this.tableHeaders = this.createTableHeaders(meta.headers);
                this.constraints = _.groupBy(meta.constraints, 'localColumn');

                // Reset to defaults
                this.meta = meta;
                this.pageNumber = 1;
                this.sort = null;

                // Unpause pageInfo
                pauser.next(false);
            });

        this.pageInfoSub = pausable.switchMap((params: [TableMeta, string, number, string]) => {
            // params is an array: [meta, name, pageNumber, sort]
            return this.backend.content(params[1], params[2], this.limit, params[3])
                // TODO Handle this properly
                .catch((err) => { throw err; })
                .map((rows: SqlRow[]) => {
                    return this.formatRows(params[0].headers, rows);
                });
        }).subscribe((data: SqlRow[]) => {
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
                if (header.type === 'datetime')
                    row[headerName] = DatatableComponent.formatMoment(row[headerName], 'LLL');
                if (header.type === 'boolean')
                    // Resolve either the 1 or 0 to its boolean value
                    row[headerName] = !!row[headerName];
            }
        }

        return copied;
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
