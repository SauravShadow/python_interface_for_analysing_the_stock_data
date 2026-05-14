--
-- PostgreSQL database dump
--

\restrict T4aeKDdefBT3BAMwiGsAObHWSSfJsc2DtAPCWkpYthsJbDfpXsfnAZUmsmcKkJx

-- Dumped from database version 15.17 (Debian 15.17-1.pgdg13+1)
-- Dumped by pg_dump version 15.17 (Debian 15.17-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: analyses; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.analyses (
    id character varying(36) NOT NULL,
    name character varying(255) NOT NULL,
    mode character varying(20) NOT NULL,
    symbols json NOT NULL,
    config json NOT NULL,
    results_summary json,
    created_at timestamp without time zone NOT NULL,
    updated_at timestamp without time zone NOT NULL
);


ALTER TABLE public.analyses OWNER TO postgres;

--
-- Name: ml_models; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.ml_models (
    id character varying(36) NOT NULL,
    name character varying(255) NOT NULL,
    symbol character varying(50) NOT NULL,
    exchange character varying(10) NOT NULL,
    model_type character varying(50) NOT NULL,
    task character varying(20) NOT NULL,
    features json NOT NULL,
    hyperparams json NOT NULL,
    filters json NOT NULL,
    metrics json,
    feature_importance json,
    model_path character varying(512),
    data_interval character varying(10) NOT NULL,
    train_from character varying(20),
    train_to character varying(20),
    created_at timestamp without time zone NOT NULL
);


ALTER TABLE public.ml_models OWNER TO postgres;

--
-- Name: watchlist; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.watchlist (
    id character varying(36) NOT NULL,
    tsym character varying(50) NOT NULL,
    token character varying(20) NOT NULL,
    exchange character varying(10) NOT NULL,
    cname character varying(255),
    added_at timestamp without time zone NOT NULL
);


ALTER TABLE public.watchlist OWNER TO postgres;

--
-- Data for Name: analyses; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.analyses (id, name, mode, symbols, config, results_summary, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: ml_models; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.ml_models (id, name, symbol, exchange, model_type, task, features, hyperparams, filters, metrics, feature_importance, model_path, data_interval, train_from, train_to, created_at) FROM stdin;
\.


--
-- Data for Name: watchlist; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.watchlist (id, tsym, token, exchange, cname, added_at) FROM stdin;
6ada4e31-217b-4f13-ad6f-41b886ab13a5	ETERNAL-EQ	5097	NSE	ETERNAL LIMITED	2026-05-13 20:21:34.626956
88132383-6150-42ba-b0d3-9be7db6bec35	SWIGGY-EQ	27066	NSE	SWIGGY LIMITED	2026-05-13 20:21:42.838589
9ce9cdc1-a44a-480d-be30-a9d9e12c5cbf	RELIANCE-EQ	2885	NSE	RELIANCE INDUSTRIES LTD	2026-05-13 20:22:11.369992
a03825bd-1248-4d40-87a8-670dffb352ff	ADANIENT-EQ	25	NSE	ADANI ENTERPRISES LIMITED	2026-05-13 20:22:20.875019
39678228-c439-4440-b35b-11fecf6a23e1	BSE-EQ	19585	NSE	BSE LIMITED	2026-05-13 20:22:39.087844
e2f27db6-12d0-47cb-a62e-b7245f24b587	SILVERIETF-EQ	7942	NSE	ICICIPRAMC - ICICISILVE	2026-05-13 20:23:05.547302
a79f03d3-420b-4bfa-b2b1-0549dcbc5521	VEDL-EQ	3063	NSE	VEDANTA LIMITED	2026-05-13 20:23:28.040757
\.


--
-- Name: analyses analyses_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.analyses
    ADD CONSTRAINT analyses_pkey PRIMARY KEY (id);


--
-- Name: ml_models ml_models_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.ml_models
    ADD CONSTRAINT ml_models_pkey PRIMARY KEY (id);


--
-- Name: watchlist watchlist_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.watchlist
    ADD CONSTRAINT watchlist_pkey PRIMARY KEY (id);


--
-- Name: watchlist watchlist_tsym_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.watchlist
    ADD CONSTRAINT watchlist_tsym_key UNIQUE (tsym);


--
-- PostgreSQL database dump complete
--

\unrestrict T4aeKDdefBT3BAMwiGsAObHWSSfJsc2DtAPCWkpYthsJbDfpXsfnAZUmsmcKkJx

