import { CollectionViewer, DataSource } from '@angular/cdk/collections';
import { Injectable } from '@angular/core';
import { MatPaginator, PageEvent, Sort } from '@angular/material';
import { clone, find, isEqual } from 'lodash';
import * as moment from 'moment';
import { BehaviorSubject, combineLatest, NEVER, Observable, of, Subscription, zip } from 'rxjs';
import { distinctUntilChanged, filter, map, switchMap, tap } from 'rxjs/operators';
import { Filter, SqlRow, TableHeader, TableMeta } from '../../common/api';
import { PaginatedResponse } from '../../common/api';
import { DATE_FORMAT, DATETIME_FORMAT } from '../../common/constants';
import { ApiService } from '../../core/api/api.service';
import { ContentRequest } from '../../core/api/content-request';
import { FilterManagerComponent } from '../filter-manager/filter-manager.component';
import { PaginatorComponent } from '../paginator/paginator.component';

/**
 * This is a DataSource that pulls data from the API. It can handle filters,
 * sorting, and pagination through FilterManagerComponent, MatSort, and
 * MatPaginator respectively.
 */
@Injectable()
export class ApiDataSource extends DataSource<SqlRow> {
    private static readonly DISPLAY_FORMAT_DATE = 'l';
    private static readonly DISPLAY_FORMAT_DATETIME = 'LLL';

    /** The current table */
    public set table(name: TableMeta | null) { this.table$.next(name); }
    public get table() { return this.table$.getValue(); }

    public allowInsertLike = false;

    // External components
    private paginator: PaginatorComponent | null = null;
    private sort: Observable<Sort> = NEVER;
    private filters: FilterManagerComponent | null;

    // Observables
    private table$ = new BehaviorSubject<TableMeta | null>(null);
    private page$ = new BehaviorSubject<number>(1);
    private pageSize$ = new BehaviorSubject<number>(25);
    private sort$ = new BehaviorSubject<string | null>(null);
    private filters$ = new BehaviorSubject<Filter[]>([]);
    private data$ = new BehaviorSubject<SqlRow[] | null>(null);

    // Subscriptions
    private pageSub: Subscription | null = null;
    private sortSub: Subscription | null = null;
    private filtersSub: Subscription | null = null;

    private source: Observable<SqlRow[]>;

    public constructor(private backend: ApiService) {
        super();

        this.source = combineLatest(
            this.table$, this.page$, this.pageSize$, this.sort$, this.filters$
        ).pipe(
            filter((data: [TableMeta, number, number, string, Filter[]]) => {
                // Only continue if we have a table. Everything else (page,
                // page size, sorting, and filters, respectively), is optional
                return data[0] !== null;
            }),
            // Prevent unnecessary requests
            distinctUntilChanged(isEqual),
            map((data: [TableMeta, number, number, string, Filter[]]): [TableMeta, ContentRequest] => {
                const req: ContentRequest = {
                    schema: data[0].schema,
                    table: data[0].name,
                    page: data[1],
                    limit: data[2],
                    sort: data[3],
                    filters: data[4]
                };
                return [data[0], req];
            }),
            switchMap((data: [TableMeta, ContentRequest]) => {
                return zip(
                    this.backend.content(data[1]),
                    of(data[0])
                );
            }),
            tap((data: [PaginatedResponse<SqlRow[]>, TableMeta]) => {
                // Update the Paginator in case the filters have changed the
                // amount of total rows
                const [res] = data;
                if (this.paginator)
                    this.paginator.totalRows = res.totalRows;
            }),
            map((data: [PaginatedResponse<SqlRow[]>, TableMeta]) =>
                // Format the rows before presenting them to the UI
                this.formatRows(data[1].headers, data[0].data)),
            tap((data: SqlRow[]) => {
                this.data$.next(data);
            })
        );
    }

    // overridden from DataSource
    public connect(collectionViewer: CollectionViewer): Observable<SqlRow[]> {
        return this.source;
    }

    public disconnect(collectionViewer: CollectionViewer): void {
        for (const subscription of [this.pageSub, this.sortSub, this.filtersSub]) {
            if (subscription) {
                subscription.unsubscribe();
            }
        }
    }

    /**
     * Attaches pagination, sorting, and filtering functionality to this data
     * source.
     */
    public init(components: {
        paginator: PaginatorComponent,
        sort: Observable<Sort>,
        filters: FilterManagerComponent,
        allowInsertLike: boolean
    }) {
        this.paginator = components.paginator;
        this.sort = components.sort;
        this.filters = components.filters;
        this.allowInsertLike = components.allowInsertLike;

        this.resetSubscriptions();

        if (this.paginator)
            this.pageSub = this.paginator.page.subscribe((event: PageEvent) => {
                this.page$.next(event.pageIndex + 1);
                this.pageSize$.next(event.pageSize);
            });

        if (this.sort)
            this.sortSub = this.sort.subscribe((sort: Sort) => {
                if (sort.direction === '') {
                    // There's no active sorting
                    this.sort$.next(null);
                } else {
                    // The user has requested to sort ascending or descending,
                    // format the sorting in the way the API expects
                    const dir = sort.direction === 'asc' ? '' : '-';
                    this.sort$.next(dir + sort.active);
                }
            });

        if (this.filters)
            this.filtersSub = this.filters.changed.subscribe((data: Filter[]) => {
                this.filters$.next(data);
            });
    }

    /**
     * Provides an Observable that emits values whenever the data changes. If
     * there is already an observer for connect(), prefer this method to avoid
     * duplicate HTTP requests.
     */
    public dataChanges(): Observable<SqlRow[]> {
        return this.data$.pipe(
            filter((data) => data !== null)
        ) as Observable<SqlRow[]>;
    }

    /**
     * Notifies this data source that the user has changed tables. Sets the
     * page to the first page.
     */
    public switchTables(meta: TableMeta) {
        this.sort$.next(null);
        this.table$.next(meta);
    }

    private resetSubscriptions() {
        if (this.pageSub) {
            this.pageSub.unsubscribe();
            this.pageSub = null;
        }
        if (this.sortSub) {
            this.sortSub.unsubscribe();
            this.sortSub = null;
        }
        if (this.filtersSub) {
            this.filtersSub.unsubscribe();
            this.filtersSub = null;
        }
    }

    private formatRows(headers: TableHeader[], rows: SqlRow[]): SqlRow[] {
        const copied = clone(rows);

        // Iterate through each row
        for (const row of copied) {
            // Iterate through each cell in that row
            for (const headerName of Object.keys(row)) {
                if (headerName === '__insertLike')
                    continue;

                const header = find(headers, (h) => h.name === headerName);
                if (header === undefined)
                    throw new Error('Can\'t find header with name ' + headerName);

                // Use moment to format dates and times in the default format
                if (header.type === 'date')
                    row[headerName] = ApiDataSource.reformat(row[headerName],
                        DATE_FORMAT, ApiDataSource.DISPLAY_FORMAT_DATE);
                if (header.type === 'datetime')
                    row[headerName] = ApiDataSource.reformat(row[headerName],
                        DATETIME_FORMAT, ApiDataSource.DISPLAY_FORMAT_DATETIME);
                if (header.type === 'boolean')
                    // Resolve either the 1 or 0 to its boolean value
                    row[headerName] = !!row[headerName];
            }

            // Create a marker so that the "insert like" column gets rendered
            if (this.allowInsertLike)
                row.__insertLike = true;
        }

        return copied;
    }

    /**
     * Tries to format a given date into the format given. If the source is not
     * a valid date, returns null.
     *
     * @param source A string parsable by Moment
     * @param input Input moment format
     * @param output Output moment format
     */
    private static reformat(source: string, input: string, output: string): string | null {
        const m = moment(source, input);
        return m.isValid() ? m.format(output) : null;
    }
}
