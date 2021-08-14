#!/usr/bin/env python3

# SPDX-License-Identifier: Apache-2.0
#
# SPDX-FileCopyrightText: © 2024 Tenstorrent Inc.

# Simple client that can be used by GUI to test connection to work area, and get information like
# list of models/tests, dumps, etc.

import socket
import sys
import struct
import json
from datetime import datetime
from pathlib import Path
from subprocess import Popen, PIPE, STDOUT
import subprocess, os
import re

TEST_PROMPT = "  CMD>"

if len(sys.argv) != 3:
    print("Usage: gui_client_utils.py [port | 'local'] workspace_root")
    exit(-1)

log_filename = os.path.expanduser("~/routeagui_server.log")

def log(msg):
    print(msg)
    with open(log_filename, "w") as f:
        f.write("{0} -- {1}\n".format(datetime.now().strftime("%Y-%m-%d %H:%M"), msg))

root = sys.argv[2]

log("Root Directory: " + root)

local = False
if sys.argv[1] == "local":
    local = True
    log('starting up in local mode')
    connection = None
    sock = None
else:

    # Create a TCP/IP socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)

    # Bind the socket to the port
    #server_address = ('localhost', 10000)
    port = int(sys.argv[1])
    server_address = ('0.0.0.0', port)
    log('starting up on {} port {}'.format(*server_address))
    try:
        sock.bind(server_address)
    except Exception as e:
        log("Socket bind error: " + str(e))
        quit(3)

    # Listen for incoming connections
    sock.listen(1)
    sock.settimeout(60)
    try:
        connection, client_address = sock.accept()
    except socket.timeout as e:
        log("Timed out waiting for a connection, shutting down.");
        quit(2)

    log("Got connection from: " + str(client_address))

def send_test_cmd(process, cmd):
    """
    Write a command into process' stdin
    """
    process.stdin.write((cmd + "\n").encode('utf-8'));
    process.stdin.flush()

def get_test_output(process):
    """
    Read test output until either a prompt or the test finishes.
    Returns:
        output: raw output
        prompt: bool - true if prompt is available
    """
    process_alive = True
    output = []
    error = None
    prompt = False
    try:
        for line in process.stdout:

            # Check if the process is done
            if process.poll() is not None and line == b'':
                process_alive = False
                log("Test process done.")
                break

            l = line.decode().rstrip()
            log("Test output: " + l)
            if l == TEST_PROMPT:
                # Prompt availble, break
                prompt = True
                break
            output.append(l)

    except Exception as e:
        error = str(e)
        log("Error while reading output from test: " + str(e))

    if not prompt:
        process.kill()
        process_alive = False

    return {
        "error": error,
        "output": output,
        "prompt": process_alive
    }

def spawn_test(test, params):
    """
    Spawn a new process with a test, and wait for either shell prompt or for it finish.
    Returns:
        process: process id, if still running
        prompt: bool - if prompt is available
        output: raw output from running
    """
    my_env = os.environ.copy()
    my_env["TT_PYTHON_PIPE_SHELL"] = "1"
    cmd = ["scripts/compile_and_run.py", "-t", test]

    try:
        process = Popen(cmd, stdout=PIPE, stdin=PIPE, stderr=STDOUT, env=my_env, cwd=root)
        test = get_test_output(process)
        test["process"] = process
        return test
    except Exception as e:
        log("Error while spawning a test: " + str(e))
        return {
            "error": str(e),
            "process": None,
            "output": [],
            "prompt": False
        }

def receive_cmd(connection):
    """
    Receive a command and parse JSON
    """
    if local:
        print("LOCAL_PROMPT>")
        rec_data = sys.stdin.readline().rstrip()
    else:
        amount_received = 0
        data = connection.recv(4)
        amount_expected = struct.unpack('<i', data)[0]
        rec_buffer = b''
        while amount_received < amount_expected:
            data = connection.recv(max(16, amount_expected - amount_received))
            amount_received += len(data)
            rec_buffer += data[:amount_received]

        rec_data = rec_buffer.decode('utf-8')

    log("Raw receive: " + rec_data)
    return json.loads(rec_data)

def send_response(connection, data):
    """
    Send data, which is convertible to JSON
    """
    if ("error" not in data) or (data["error"] is None):
        data["error"] = ""  # explicitly set empty error
    json_data = json.dumps(data)

    if local:
        print("JSON:", json_data)
    else:
        send_data = json_data.encode('utf-8')
        l = struct.pack('<i', len(send_data))
        log("sending " + str(send_data))
        connection.sendall(l)
        connection.sendall(send_data)

def is_netlist_yaml(filename):
    """
    Check if a yaml file is a netlist. Quick & trivial check at this point.
    """
    import yaml
    with open(filename, "r") as stream:
        try:
            data = yaml.safe_load(stream)
            if data is None:
                return False
            return "graphs" in data and "queues" in data
        except yaml.YAMLError as exc:
            return False

# Perf dump data class
class PerfDumpData:
    def __init__(self, path_to_output_dir):
        self.path_to_output_dir = path_to_output_dir
        if not os.path.isdir(self.path_to_output_dir):
            self.data_string = "{}"
            return

        sub_folders = self.get_subfolders(self.path_to_output_dir)
        # if user selected a single folder that directly contains postprocess and host data files, load the folder name and return
        if not sub_folders:
            silicon_regex = r'^perf_postprocess.json$'
            silicon_regex_spatial1 = r'^perf_postprocess_epoch_(\d+).json$'
            files = os.listdir(self.path_to_output_dir)
            found_post_process = False
            for file in files:
                if re.match(silicon_regex, file) or re.match(silicon_regex_spatial1, file):
                    found_post_process = True
                    break
            if not found_post_process:
                self.data_string = "{}"

            elif found_post_process:
                self.folder_map = {os.path.basename(self.path_to_output_dir): {}}
                self.data_string = self.get_perf_dump_data_single_dir(self.path_to_output_dir, self.folder_map)

        # if user chose a nested directory, find all data files under all nested directories
        elif sub_folders:
            self.all_folder_paths = self.get_all_folder_paths(self.path_to_output_dir)

            self.folder_map = self.set_folder_map(self.all_folder_paths)

            self.data_string = self.get_perf_dump_data(self.path_to_output_dir, self.folder_map, self.all_folder_paths)

    # folder map is a tree like structure containing folder names on different folder levels
    def set_folder_map(self, all_folder_paths):
        folder_map = {}
        for folder_path in all_folder_paths:
            sub_folder_map = folder_map
            for folder in folder_path:
                if folder not in sub_folder_map:
                    sub_folder_map[folder] = {}
                sub_folder_map = sub_folder_map[folder]

        return folder_map


    # get all possible folder paths (directory paths leading to perf_postprocess data)
    def get_all_folder_paths(self, folder_path):
        silicon_regex = r'^perf_postprocess.json$'
        silicon_regex_spatial1 = r'^perf_postprocess_epoch_(\d+).json$'
        # print(sub_folders)
        all_folder_paths = []
        temp_folder_paths = []
        # extract all paths that point to host data or perf_postprocess.json files, store them in all_folder_paths
        def extract_all_folder_paths(folderpath):
            # if folderpath points to host, append folderpath to all_folder_paths
            if os.path.basename(folderpath) == "host":
                json_files = self.find_host_json_files(folderpath)
                if json_files:
                    folder_names = [os.path.basename(folder) for folder in temp_folder_paths]
                    all_folder_paths.append(folder_names)
                return

            sub_folders = self.get_subfolders(folderpath)
            # when all sub folders of folderpath are files, check if this directory has perf_postprocess.json files
            # if folderpath contains perf_postprocess.json files, append folderpath to all_folder_paths
            if not sub_folders:
                file_paths = os.listdir(folderpath)
                post_processes = []
                for file in file_paths:
                    if re.match(silicon_regex, file) or re.match(silicon_regex_spatial1, file):
                        post_processes.append(os.path.join(folderpath, file))

                # there should be only 1 post process json file
                if len(post_processes) == 1:
                    data = None
                    with open(post_processes[0], "r") as post_process:
                        data = json.load(post_process)
                        post_process.close()
                    # check if data is null
                    if data:
                        folder_names = [os.path.basename(folder) for folder in temp_folder_paths]
                        all_folder_paths.append(folder_names)
                return

            for sub_folder in sub_folders:
                temp_folder_paths.append(sub_folder)
                extract_all_folder_paths(sub_folder)
                temp_folder_paths.pop()

        extract_all_folder_paths(folder_path)
        return all_folder_paths

    # handle special case where user chose a directory directly containing json files
    def get_perf_dump_data_single_dir(self, path_to_output_dir, folder_map):
        silicon_regex = r'^perf_postprocess.json$'
        silicon_regex_spatial1 = r'^perf_postprocess_epoch_(\d+).json$'
        model_regex = r'^runtime_table.json$'
        model_regex_spatial1 = r'^runtime_table_epoch_(\d+).json$'
        silicon_data = {}
        model_data = {}
        graph_data = {}
        json_files = self.find_perf_json_files(path_to_output_dir)
        # if 'host' in os.listdir(path_to_output_dir) and os.path.isdir(os.path.join(path_to_output_dir, 'host')):
        #     # path from root to folder that contains data we are interested in
        #     data_path = os.path.join(path_to_output_dir, 'host')
        #     host_json_files = self.find_host_json_files(data_path)
        #     json_data = {}
        #     for json_file in host_json_files:
        #         with open(json_file, "r") as file:
        #             json_data.update(json.load(file))
        #             file.close()

        #     host_data["/".join([os.path.basename(path_to_output_dir), 'host'])] = json_data
        #     folder_map

        foldername = os.path.basename(path_to_output_dir)
        for json_file in json_files:
            json_file_name = os.path.basename(json_file)
            with open(json_file, "r") as file:
                if re.match(silicon_regex, json_file_name) or re.match(silicon_regex_spatial1, json_file_name):
                    data = json.load(file)
                    if data:
                        silicon_data[foldername] = data

                elif re.match(model_regex, json_file_name) or re.match(model_regex_spatial1, json_file_name):
                    data = json.load(file)
                    if data:
                        model_data[foldername] = data

                file.close()

        graph_dumps = self.find_graph_dumps(path_to_output_dir)
        for graph_dump in graph_dumps:
            with open(graph_dump, "r") as file:
                graph_data[foldername] = file.read()
                file.close()

        data = {}
        if folder_map:
            data["folderMap"] = folder_map
            if silicon_data:
                data["silicon"] = silicon_data
                if model_data:
                    data["model"] = model_data
                if graph_data:
                    data["graph"] = graph_data

        return json.dumps(data, sort_keys=True, indent=4)

    # get perf dump data and return as string
    def get_perf_dump_data(self, path_to_output_dir, folder_map, all_folder_paths):
        silicon_regex = r'^perf_postprocess.json$'
        silicon_regex_spatial1 = r'^perf_postprocess_epoch_(\d+).json$'
        model_regex = r'^runtime_table.json$'
        model_regex_spatial1 = r'^runtime_table_epoch_(\d+).json$'
        host_json_regex = r'^(.*)proc_(\d+).json$'
        silicon_data = {}
        model_data = {}
        graph_data = {}
        host_data = {}

        for folder_path in all_folder_paths:
            # path from root to folder that contains data we are interested in
            data_path = os.path.join(path_to_output_dir, *folder_path)

            # populate host data
            if folder_path[-1] == "host":
                host_json_files = self.find_host_json_files(data_path)
                json_data = {}
                for json_file in host_json_files:
                    with open(json_file, "r") as file:
                        data = json.load(file)
                        if data:
                            for host_event_data in data.values():
                                if not host_event_data:
                                    continue
                                host_event_data["process-id"] = re.match(host_json_regex, os.path.basename(json_file)).group(2)
                            json_data.update(data)
                        file.close()
                if json_data:
                    host_data["/".join(folder_path)] = json_data
                continue

            # populate silicon and model data
            json_files = self.find_perf_json_files(data_path)
            for json_file in json_files:
                json_file_name = os.path.basename(json_file)
                with open(json_file, "r") as file:
                    # already checked in folder map whether silicon data is null
                    if re.match(silicon_regex, json_file_name) or re.match(silicon_regex_spatial1, json_file_name):
                        silicon_data["/".join(folder_path)] = json.load(file)

                    elif re.match(model_regex, json_file_name) or re.match(model_regex_spatial1, json_file_name):
                        data = json.load(file)
                        if data:
                            model_data["/".join(folder_path)] = data

                    file.close()

            # populate graph_dump data
            graph_dumps = self.find_graph_dumps(data_path)
            for graph_dump in graph_dumps:
                with open(graph_dump, "r") as file:
                    graph_data["/".join(folder_path)] = file.read()
                    file.close()

        data = {}
        if folder_map:
            data["folderMap"] = folder_map
            if silicon_data:
                data["silicon"] = silicon_data
                if model_data:
                    data["model"] = model_data
                if graph_data:
                    data["graph"] = graph_data
            if host_data:
                data["host"] = host_data

        return json.dumps(data, sort_keys=True, indent=4)

    # get sub folders of a folder
    def get_subfolders(self, folderpath):
        return [os.path.join(folderpath, subpath) for subpath in os.listdir(folderpath) if os.path.isdir(os.path.join(folderpath, subpath))]

    # find all relavant json files under a folder
    def find_perf_json_files(self, folderpath):
        silicon_regex = r'^perf_postprocess.json$'
        silicon_regex_spatial1 = r'^perf_postprocess_epoch_(\d+).json$'
        model_regex = r'^runtime_table.json$'
        model_regex_spatial1 = r'^runtime_table_epoch_(\d+).json$'
        json_files = []
        for filename in os.listdir(folderpath):
            path_to_file = os.path.join(folderpath, filename)
            if not os.path.isfile(path_to_file):
                continue
            if re.match(silicon_regex, filename) or re.match(silicon_regex_spatial1, filename) or re.match(model_regex, filename) or re.match(model_regex_spatial1, filename):
                json_files.append(path_to_file)
        return json_files

    def find_graph_dumps(self, folderpath):
        graph_regex = r'^perf_graph_(\S+).dot$'
        graph_dumps = []
        for filename in os.listdir(folderpath):
            path_to_file = os.path.join(folderpath, filename)
            if not os.path.isfile(path_to_file):
                continue
            if re.match(graph_regex, filename):
                graph_dumps.append(path_to_file)
        return graph_dumps

    def find_host_json_files(self, hostPath):
        host_json_regex = r'^(.*)proc_(\d+).json$'
        return [os.path.join(hostPath, file) for file in os.listdir(hostPath) if (os.path.isfile(os.path.join(hostPath, file)) and re.match(host_json_regex, file))]

    def write_data_to_file(self, uselog = True, filepath = None):
        if uselog:
            log("Perf dump data: \n" + self.data_string)
            print("Successfully wrote perf dump data to log.")
            return
        if filepath:
            with open(filepath, "a") as f:
                f.write(self.data_string)
                print("Successfully wrote perf dump data to file: " + filepath)
                f.close()

def find_perf_postprocess(path):
    postprocess_spatial2 = subprocess.run(['find', path, '-name', 'perf_postprocess.json'], stdout=subprocess.PIPE, cwd=root)
    postprocess_spatial2 = postprocess_spatial2.stdout.decode('utf-8').rstrip()

    # find command has differences on mac and linux, using -regex and [0-9]+ to replace * works on linux but fails on mac
    postprocess_spatial1 = subprocess.run(['find', path, '-name', 'perf_postprocess_epoch_*.json'], stdout=subprocess.PIPE, cwd=root)
    postprocess_spatial1 = postprocess_spatial1.stdout.decode('utf-8').rstrip()

    if len(postprocess_spatial2) > 0:
        return postprocess_spatial2.split("\n")
    elif len(postprocess_spatial1) > 0:
        return postprocess_spatial1.split("\n")
    else:
        return []

done = False
try:
    while not done:
        try:
            d = receive_cmd(connection)
            log("Received cmd: " + str(d))
            cmd = d['cmd']

            if cmd == "quit":
                send_response(connection, {"data": "quit_ack"})
                done = True

            elif cmd == "echo":
                # respond back with same msg, confirming that communication works
                send_response(connection, d)

            elif cmd == "list_tests":
                # return list of available tests
                #result = subprocess.run(['make', '-f', 'model/tests/module.mk', 'print_tests'], stdout=subprocess.PIPE, cwd=root)
                #result = result.stdout.decode('utf-8').rstrip().split(' ')
                result = []
                send_response(connection, {"data": result})

            elif cmd == "list_spatial_json":
                # return list of spatial json file in give dir
                folder = d['dir']
                result = subprocess.run(['find', folder, '-name', 'gui_dump.json'], stdout=subprocess.PIPE, cwd=root)
                result = result.stdout.decode('utf-8').rstrip().split('\n')
                send_response(connection, {"data": result})

            elif cmd == "list_netlist_yaml":
                # return list of netlist yaml files
                folder = d['dir']
                result = subprocess.run(['find', folder, '-maxdepth', '1', '-name', '*.yaml'], stdout=subprocess.PIPE, cwd=root)
                result = result.stdout.decode('utf-8').rstrip().split('\n')

                # for each yaml file, load and check that it's a netlist
                netlists = result
                send_response(connection, {"data": netlists})

            elif cmd == "list_all_perf_results":
                # return list of perf results folders in workspace/tt_build
                tt_build = d['dir']
                perf_results = subprocess.run(['find', tt_build, '-mindepth', '2', '-maxdepth', '2', '-name', 'perf_results'], stdout=subprocess.PIPE, cwd=root)
                perf_results = perf_results.stdout.decode('utf-8').rstrip().split('\n')

                result = [folder for folder in perf_results if os.path.isdir(folder)]

                send_response(connection, {"data": result})

            elif cmd == "read_perf_dump_folder":
                perfdata = PerfDumpData(d['dir'])
                result = perfdata.data_string.split('\n')
                send_response(connection, {"data": result})

            elif cmd == "read_file":
                # read a file (typically json) and send it to the client
                folder = d['dir']
                filename = d['filename']
                if not filename.startswith("/"):
                    filename = folder + "/" + filename
                data = Path(filename).read_text().split('\n')
                send_response(connection, {"data": data})

            elif cmd == "write_file":
                # read a file (typically json) and send it to the client
                filename = d['filename']
                data = d['data']
                Path(filename).write_text(data)
                send_response(connection, {})

            elif cmd == "run_test":
                # run a test and send back gui dump
                test = d['test']
                test = spawn_test(test, d)
                log(test)
                output = test["output"]
                if test["error"] is not None:
                    send_response(connection, {"error": test["error"], "output": output})
                    continue

                if not test["prompt"]:
                    send_response(connection, {"error": "Test completed without a prompt.", "output": output})
                    continue


                send_test_cmd(test["process"], "list_ops()") # for now, something that works
                out = get_test_output(test["process"])
                output.extend(out["output"])
                data = out["output"]

                if out["error"] is not None:
                    send_response(connection, {"error": test["error"], "output": output})
                    continue

                if not test["prompt"]:
                    send_response(connection, {"error": "Test stopped after first command.", "output": output})
                    continue

                send_test_cmd(test["process"], "exit()")
                out = get_test_output(test["process"])
                output.extend(out["output"])

                send_response(connection, {"error": out["error"], "output": output, "data": data})
                test["process"].kill()
            else:
                send_response(connection, {"error": "unknown command"})

        except Exception as e:
            log(f"Main Loop Exception: {str(e)}")
            send_response(connection, {"error": str(e)})
    # Send data
    #talk(b'This is the message.  It will be repeated.')
    #talk(b'This is second message.')

    #val0 = struct.pack('<i', 0);
    #val1 = struct.pack('<i', 1);
    #sock.sendall(val1)
    #sock.sendall(val0)
    #cmd = receive_cmd()
    #print(cmd)

finally:
    log('closing socket')
    if sock:
        sock.close()
