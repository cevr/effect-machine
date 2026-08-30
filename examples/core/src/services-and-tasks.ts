import { Cause, Context, Effect, Schema } from "effect";
import { Event, Machine, State } from "effect-machine";

export class Catalog extends Context.Service<
  Catalog,
  {
    readonly search: (query: string) => Effect.Effect<ReadonlyArray<string>, "unavailable">;
  }
>()("effect-machine/examples/Catalog") {}

export const SearchState = State({
  Searching: { query: Schema.String },
  Results: { items: Schema.Array(Schema.String) },
  Failed: { message: Schema.String },
});

export const SearchEvent = Event({
  SearchSucceeded: { items: Schema.Array(Schema.String) },
  SearchFailed: { message: Schema.String },
});

export const searchMachine = Machine.make({
  state: SearchState,
  event: SearchEvent,
  initial: (input: { readonly query: string }) => SearchState.Searching(input),
})
  .task(
    SearchState.Searching,
    ({ state }) => Effect.flatMap(Catalog, (catalog) => catalog.search(state.query)),
    {
      name: "catalog-search",
      onSuccess: (items) => SearchEvent.SearchSucceeded({ items }),
      onFailure: (cause) => SearchEvent.SearchFailed({ message: Cause.pretty(cause) }),
    },
  )
  .on(SearchState.Searching, SearchEvent.SearchSucceeded, ({ event }) =>
    SearchState.Results({ items: event.items }),
  )
  .on(SearchState.Searching, SearchEvent.SearchFailed, ({ event }) =>
    SearchState.Failed({ message: event.message }),
  )
  .final(SearchState.Results, ({ state }) => state.items)
  .final(SearchState.Failed, () => []);

export const servicesAndTasksProgram = Machine.run(searchMachine, {
  input: { query: "coffee" },
}).pipe(
  Effect.provideService(Catalog, {
    search: (query) => Effect.succeed([`${query} beans`, `${query} grinder`]),
  }),
);
